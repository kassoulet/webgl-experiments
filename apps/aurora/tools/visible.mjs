#!/usr/bin/env node
// A one-off headful Chrome driver for the manual aurora pass: the shared
// tools/chrome.ts harness is hardwired --headless, and the point of this pass
// is the things headless cannot see (a real window, a real compositor, the
// service worker activating the way an installed PWA sees it). Drives CDP over
// the built-in WebSocket like the harness does, prints what it finds, exits 0
// if every check holds.
//
//   node tools/visible.mjs
//
// It serves `dist/` itself on an ephemeral port, so nothing has to be running
// already; everything lives inside this one process.

import { spawn } from 'node:child_process';
import { createReadStream, promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve, normalize } from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
// The WebSocket is Node's built-in (an EventTarget, not an EventEmitter —
// the same one the shared tools/chrome.ts harness talks CDP over).

// Same layout rule as the other tools: strip tools-dist off when running
// compiled, so the site dir resolves either way.
const PKG = resolve(fileURLToPath(new URL('..', import.meta.url))).replace(/\/tools-dist$/, '');
const SITE = join(PKG, 'dist');

const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';

// A minimal static server for dist/ — the same headers tools/serve.ts sends
// (the isolation pair a real host would add), inlined so this driver is
// self-contained and needs no compile step.
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\.])+/, '');
  const file = join(SITE, path === '' ? 'index.html' : path);
  const type = TYPES[extname(file)] ?? 'application/octet-stream';
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Content-Type', type);
  const stream = createReadStream(file);
  stream.on('error', () => {
    response.statusCode = 404;
    response.end('not found');
  });
  stream.pipe(response);
});
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const address = server.address();
const serverPort = typeof address === 'object' && address ? address.port : 0;
const BASE = `http://127.0.0.1:${serverPort}`;

const profile = await mkdtemp(join(tmpdir(), 'aurora-visible-'));
const debugPort = 9400 + Math.floor(Math.random() * 300);
const child = spawn(
  CHROME,
  [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--start-maximized',
    '--window-size=1280,800',
    // CDP-dispatched clicks do not carry Chrome's audio activation, so the
    // policy flag rides along like the smoke test's; the click itself still
    // exercises the real Start handler path.
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);
let stderr = '';
child.stderr.on('data', (c) => { stderr += c; });

let ws = null;
let nextId = 1;
const pending = new Map();
const consoleLines = [];
const pageErrors = [];

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed');
  return result.result.value;
}

try {
  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    await delay(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) wsUrl = page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
  }
  if (!wsUrl) throw new Error(`Chrome did not come up\n${stderr.slice(-500)}`);

  ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      consoleLines.push(`[${msg.params.type}] ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 160)}`);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(String(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? '').slice(0, 200));
    }
  });

  await send('Runtime.enable');
  await send('Page.enable');
  const checks = [];
  const check = (name, ok, detail = '') => {
    checks.push(ok);
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  // 1. A real window opens the app.
  await send('Page.navigate', { url: `${BASE}/#s=${encodeURIComponent('visible-pass')}` });
  // Wait for the document and the app's canvas, not a guess about load time.
  for (let i = 0; i < 40; i++) {
    await delay(250);
    try {
      if (await evaluate('document.readyState === "complete" && document.getElementById("visual") !== null')) break;
    } catch { /* mid-navigation */ }
  }
  const title = await evaluate('document.title');
  const enterHidden = await evaluate('document.getElementById("enter").classList.contains("hidden")');
  const canvas = await evaluate('(() => { const c = document.getElementById("visual"); return { w: c.clientWidth, h: c.clientHeight }; })()');
  check('the window opens the app', title === 'Aurora' && !enterHidden, `title "${title}", enter hidden ${enterHidden}, canvas ${canvas.w}x${canvas.h}`);

  // 2. The service worker is registered, activated and controlling the page.
  const sw = await evaluate(`(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return { registered: false };
    const state = reg.active ? 'active' : reg.installing ? 'installing' : reg.waiting ? 'waiting' : 'none';
    const controlling = Boolean(navigator.serviceWorker.controller);
    return { registered: true, state, controlling, scope: reg.scope };
  })()`);
  check('the service worker is active and controlling', sw.registered && sw.state === 'active' && sw.controlling, JSON.stringify(sw));

  // 3. The manifest is fetchable and its icons resolve (the install criteria).
  const manifest = await evaluate(`(async () => {
    const link = document.querySelector('link[rel=manifest]');
    const res = await fetch(link.href);
    const json = await res.json();
    const icons = await Promise.all(json.icons.map(async (i) => {
      const r = await fetch(new URL(i.src, location.origin));
      const type = r.headers.get('content-type');
      return { src: i.src, ok: r.ok, bytes: (await r.blob()).size, type };
    }));
    return { name: json.name, display: json.display, icons };
  })()`);
  const iconsOk = manifest.icons.every((i) => i.ok && i.bytes > 1000 && i.type === 'image/png');
  check('the manifest and its icons are installable', manifest.name === 'Aurora' && iconsOk, JSON.stringify(manifest));

  // 4. Click Begin; the audio clock runs.
  const start = await evaluate(`(() => {
    const b = document.getElementById('start');
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: start.x, y: start.y, button: 'left', clickCount: 1 });
  let clock = 0;
  for (let i = 0; i < 30; i++) {
    await delay(500);
    clock = await evaluate('__aurora.engine.getStats().clock');
    if (clock > 2) break;
  }
  check('the set starts on a real click', clock > 2, `clock ${Number(clock).toFixed(2)}s`);

  // 5. A frame was actually composited to the window (read pixels back).
  const pixels = await evaluate(`(() => {
    const c = document.getElementById('visual');
    const gl = c.getContext('webgl2');
    const px = new Uint8Array(4 * 64);
    gl.readPixels(Math.floor(c.width / 2) - 32, Math.floor(c.height / 2), 64, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let sum = 0;
    for (const v of px) sum += v;
    return sum;
  })()`);
  check('the canvas has live pixels on screen', pixels > 0, `center-row pixel sum ${pixels}`);

  // 6. The shell is cached for offline (the PWA promise).
  const shellCached = await evaluate(`(async () => {
    const names = await caches.keys();
    if (!names.length) return 0;
    const cache = await caches.open(names[0]);
    return (await cache.keys()).length;
  })()`);
  const cacheNames = await evaluate('caches.keys().then((k) => k)');
  check('the shell is precached', cacheNames.length > 0 && shellCached >= 5, `caches ${JSON.stringify(cacheNames)}, ${shellCached} entries`);

  // 7. Screenshot of the real window, for the record.
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile('/tmp/aurora-visible.png', Buffer.from(shot.data, 'base64'));
  check('a window screenshot was captured', true, '/tmp/aurora-visible.png');

  await delay(1000);
  check('no script errors in the visible run', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  const interesting = consoleLines.filter((l) => !l.includes('icon from the Manifest'));
  if (interesting.length) {
    console.log('\n  console:');
    for (const line of interesting.slice(0, 10)) console.log(`    ${line}`);
  }

  console.log(`\n${checks.filter(Boolean).length}/${checks.length} visible checks passed`);
  process.exit(checks.every(Boolean) ? 0 : 1);
} catch (error) {
  console.error('visible pass failed:', error.message ?? error);
  if (stderr) console.error(stderr.slice(-600));
  process.exit(2);
} finally {
  child.kill();
  ws?.close();
  server.close();
}
