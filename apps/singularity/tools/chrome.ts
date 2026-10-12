// The headless browser harness the tools share: serve the build, launch Chrome
// with software WebGL2, and talk to it over the DevTools protocol on the
// built-in `WebSocket`. `smoke.ts`, `stars.ts` and `soak.ts` all drive the page
// through this, so there is one place that knows how to start a browser here.
//
// It is deliberately small: no puppeteer, no devtools package. Everything the
// tools need is `Runtime.evaluate` plus a few `Page` and `Input` commands.

import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { createStaticServer } from './serve.js';

export function findChrome(): string | null {
  const candidates = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

// --- Chrome DevTools Protocol, over the built-in WebSocket -------------------

export interface LogLine {
  level: string;
  text: string;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/** A CDP message, narrowed only as far as these tools read it. */
interface CdpMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message: string };
}

interface EvaluateResult {
  result: { value: unknown };
  exceptionDetails?: { exception?: { description?: string } };
}

interface CdpTarget {
  type: string;
  webSocketDebuggerUrl?: string;
}

export class Chrome {
  private readonly ws: WebSocket;
  private id = 0;
  private readonly pending = new Map<number, PendingCall>();
  readonly logs: LogLine[] = [];
  readonly errors: string[] = [];

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (event) => this.#onMessage(String(event.data)));
  }

  #onMessage(text: string): void {
    const message = JSON.parse(text) as CdpMessage;

    if (message.id != null) {
      const call = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (!call) return;
      if (message.error) call.reject(new Error(message.error.message));
      else call.resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const { exceptionDetails } = message.params as {
        exceptionDetails: { text: string; exception?: { description?: string } };
      };
      this.errors.push(exceptionDetails.exception?.description ?? exceptionDetails.text);
    } else if (message.method === 'Runtime.consoleAPICalled') {
      const params = message.params as {
        type: string;
        args: { value?: unknown; description?: string }[];
      };
      const line = params.args.map((a) => a.value ?? a.description ?? '').join(' ');
      this.logs.push({ level: params.type, text: line });
      if (params.type === 'error') this.errors.push(line);
    } else if (message.method === 'Log.entryAdded') {
      const { entry } = message.params as { entry: { level: string; text: string } };
      this.logs.push({ level: entry.level, text: entry.text });
      if (entry.level === 'error') this.errors.push(entry.text);
    }
  }

  send<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 20000): Promise<T> {
    const id = ++this.id;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, timeoutMs);
    });
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const result = await this.send<EvaluateResult>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'evaluation failed');
    }
    return result.result.value as T;
  }

  /**
   * A screenshot: the PNG the page is showing right now. It gets a longer
   * timeout than everything else — a software renderer can take tens of seconds
   * to produce the frame behind it, and a capture is not a hang.
   */
  async screenshot(): Promise<Buffer> {
    const shot = await this.send<{ data: string }>('Page.captureScreenshot', { format: 'png' }, 180000);
    return Buffer.from(shot.data, 'base64');
  }

  /** Click a point the way a person does, so the page sees a real gesture. */
  async click(x: number, y: number): Promise<void> {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    }
  }

  /** The centre of an element, in viewport coordinates. */
  async centreOf(id: string): Promise<{ x: number; y: number }> {
    const box = await this.evaluate<string>(
      `JSON.stringify(document.getElementById(${JSON.stringify(id)}).getBoundingClientRect())`,
    );
    const rect = JSON.parse(box) as { x: number; y: number; width: number; height: number };
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}

// --- the harness -------------------------------------------------------------

export interface HarnessOptions {
  /** The directory to serve — the built site. */
  site: string;
  /** Where the Chrome profile goes (and any captures the tool writes). */
  artifacts: string;
  /** Viewport in CSS pixels. */
  windowSize?: string;
  /** Keep the Chrome profile on disk for inspection. */
  keepProfile?: boolean;
  /** Extra Chrome flags, on top of the headless defaults. */
  args?: string[];
}

export interface Harness {
  chrome: Chrome;
  chromePath: string;
  /** Where the build is being served, e.g. `http://127.0.0.1:39281`. */
  origin: string;
  /** Anything Chrome wrote to stderr. */
  stderr(): string;
  /** Load the app with a seed in the URL fragment. */
  go(seed: string, quality?: string): Promise<void>;
  /** Wait for an expression to be true in the page. */
  waitFor(expression: string, timeoutMs?: number): Promise<boolean>;
  /** Wait for the page to be loaded and the app's diagnostic hook up. */
  loaded(timeoutMs?: number): Promise<boolean>;
  close(): Promise<void>;
}

export async function launchChrome(options: HarnessOptions): Promise<Harness> {
  const { site, artifacts, windowSize = '1280,720', keepProfile = false } = options;
  const chromePath = findChrome();
  if (!chromePath) throw new Error('no Chrome found; set CHROME_PATH');

  const server = createStaticServer(site);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const origin = `http://127.0.0.1:${port}`;

  const debugPort = 9333 + Math.floor(Math.random() * 400);
  const profile = join(artifacts, 'chrome-profile');
  await fs.mkdir(profile, { recursive: true });

  const child: ChildProcess = spawn(
    chromePath,
    [
      '--headless=new',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      // Software WebGL2, so this works on a machine with no display adapter.
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--enable-precise-memory-info',
      `--window-size=${windowSize}`,
      ...(options.args ?? []),
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let chromeStderr = '';
  child.stderr?.on('data', (chunk) => {
    chromeStderr += chunk;
  });

  let wsUrl: string | null = null;
  for (let attempt = 0; attempt < 60 && !wsUrl; attempt++) {
    await delay(250);
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const targets = (await response.json()) as CdpTarget[];
      const page = targets.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) wsUrl = page.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
  }

  const stop = async (): Promise<void> => {
    chrome.close();
    child.kill('SIGKILL');
    server.close();
    if (!keepProfile) await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  };

  if (!wsUrl) {
    child.kill('SIGKILL');
    server.close();
    throw new Error(`Chrome never opened a debugging port: ${chromeStderr.slice(0, 800)}`);
  }

  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('could not open the debugging socket')), { once: true });
  });
  const chrome = new Chrome(ws);

  await chrome.send('Runtime.enable');
  await chrome.send('Log.enable');
  await chrome.send('Page.enable');

  // `--window-size` does not survive into the page's layout: the viewport comes
  // back a different size (Chrome's own default window, minus its chrome). Ask
  // for the viewport directly, so a capture is the size the tool says it is and
  // anything measured in pixels means the pixels it claims.
  const [width, height] = windowSize.split(',').map((n) => Number(n.trim()));
  if (width && height) {
    await chrome.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  const waitFor = async (expression: string, timeoutMs = 12000): Promise<boolean> => {
    const attempts = Math.ceil(timeoutMs / 150);
    for (let attempt = 0; attempt < attempts; attempt++) {
      await delay(150);
      // A navigation destroys the execution context under an evaluation, which
      // is what the catch is for: the next poll lands in the new document.
      if (await chrome.evaluate<boolean>(expression).catch(() => false)) return true;
    }
    return false;
  };

  const harness: Harness = {
    chrome,
    chromePath,
    origin,
    stderr: () => chromeStderr,
    async go(seed: string, quality?: string) {
      const url = `${origin}/#s=${encodeURIComponent(seed)}${quality ? `&q=${encodeURIComponent(quality)}` : ''}`;
      await chrome.send('Page.navigate', { url });
    },
    waitFor,
    loaded: (timeoutMs = 12000) =>
      waitFor('document.readyState === "complete" && !!__singularity', timeoutMs),
    async close() {
      await stop();
    },
  };
  return harness;
}
