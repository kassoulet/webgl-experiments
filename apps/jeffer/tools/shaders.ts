#!/usr/bin/env node
// Compile every shader in the app, in a real WebGL2 context, and check that the
// scene program's uniforms are the ones the renderer sets.
//
// This tool exists because of what a GLSL error actually does. A shader that
// fails to compile leaves a black rectangle: no exception, no console message
// anyone reads, no test failure — just a picture that is not there. Every other
// failure mode in this app announces itself. So the shaders are checked on
// their own, before anything else, and the check does not need the app built.
//
// It checks two things, and the second is the one that has bitten before:
//
//   1. Every program compiles and links.
//   2. The set of *active* uniforms in the scene program is exactly the set the
//      renderer looks up. A uniform that is optimised away (declared, never
//      read) and a uniform the renderer misspells are both silent: the first
//      costs a per-frame write into a null location, the second costs a
//      uniform that never reaches the GPU and a picture with a number stuck at
//      zero. Neither throws. Listing the active uniforms and comparing is the
//      only way to see either one.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchChrome } from './chrome.ts';
import { VERTEX_SHADER, FRAGMENT_SHADER } from '../src/visuals/shaders.ts';
import {
  BLOOM_VERTEX_SHADER,
  BLOOM_FRAGMENT_SHADER,
  COMPOSITE_VERTEX_SHADER,
  COMPOSITE_FRAGMENT_SHADER,
  METER_FRAGMENT_SHADER,
} from '../src/visuals/bloom.ts';

const ARTIFACTS = fileURLToPath(new URL('../.smoke/', import.meta.url));

/** The uniforms the scene program is expected to have, in the renderer's own
 *  order. Kept here as a literal rather than imported so that editing the
 *  renderer's list without editing the shader is what this tool catches. */
const EXPECTED_UNIFORMS = [
  'uRes', 'uTime', 'uSeed',
  'uVoid', 'uDeep', 'uMid', 'uHot', 'uAccent',
  'uMix', 'uLevels', 'uPulse', 'uDrift',
  'uScope', 'uScopeBins', 'uScopePeak', 'uScopeRms', 'uScopeSigned', 'uTrigger', 'uSweep', 'uScopeGain',
  'uOctaves', 'uExposure', 'uScanLines',
];

interface ProgramResult {
  name: string;
  ok: boolean;
  log: string;
  /** Active uniform names, scene program only. */
  uniforms?: string[];
}

const PAGE = (programs: { name: string; vertex: string; fragment: string }[]): string => `<!doctype html>
<meta charset="utf-8">
<title>shader check</title>
<canvas id="c" width="64" height="64"></canvas>
<script>
const PROGRAMS = ${JSON.stringify(programs)};

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    return { error: log };
  }
  return { shader };
}

window.runShaderCheck = () => {
  const gl = document.getElementById('c').getContext('webgl2');
  if (!gl) return [{ name: 'webgl2', ok: false, log: 'no WebGL2 context' }];
  const out = [];
  for (const p of PROGRAMS) {
    const v = compile(gl, gl.VERTEX_SHADER, p.vertex);
    if (v.error) { out.push({ name: p.name, ok: false, log: 'vertex: ' + v.error }); continue; }
    const f = compile(gl, gl.FRAGMENT_SHADER, p.fragment);
    if (f.error) { out.push({ name: p.name, ok: false, log: 'fragment: ' + f.error }); continue; }
    const program = gl.createProgram();
    gl.attachShader(program, v.shader);
    gl.attachShader(program, f.shader);
    gl.linkProgram(program);
    gl.deleteShader(v.shader);
    gl.deleteShader(f.shader);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      out.push({ name: p.name, ok: false, log: 'link: ' + gl.getProgramInfoLog(program) });
      continue;
    }
    const uniforms = [];
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(program, i);
      // Array uniforms come back as "name[0]"; the renderer sets them by base
      // name, and none of these are arrays, so strip it either way.
      uniforms.push(info.name.replace(/\\[0\\]$/, ''));
    }
    out.push({ name: p.name, ok: true, log: '', uniforms });
  }
  return out;
};
</script>
`;

async function main(): Promise<void> {
  await fs.mkdir(ARTIFACTS, { recursive: true });
  const site = join(ARTIFACTS, 'shaders');
  await fs.rm(site, { recursive: true, force: true });
  await fs.mkdir(site, { recursive: true });
  await fs.writeFile(
    join(site, 'index.html'),
    PAGE([
      { name: 'scene', vertex: VERTEX_SHADER, fragment: FRAGMENT_SHADER },
      { name: 'bloom', vertex: BLOOM_VERTEX_SHADER, fragment: BLOOM_FRAGMENT_SHADER },
      { name: 'composite', vertex: COMPOSITE_VERTEX_SHADER, fragment: COMPOSITE_FRAGMENT_SHADER },
      { name: 'meter', vertex: BLOOM_VERTEX_SHADER, fragment: METER_FRAGMENT_SHADER },
    ]),
    'utf8',
  );

  const harness = await launchChrome({ site, artifacts: ARTIFACTS, windowSize: '320,240' });
  let failed = false;
  try {
    await harness.go('/');
    if (!(await harness.waitFor('typeof window.runShaderCheck === "function"', 10000))) {
      throw new Error(`the check page never loaded: ${harness.stderr().slice(0, 600)}`);
    }
    const results = (await harness.chrome.evaluate<ProgramResult[]>('window.runShaderCheck()')) ?? [];
    if (results.length === 0) throw new Error('the check page returned nothing');

    for (const result of results) {
      if (!result.ok) {
        failed = true;
        console.error(`  FAIL  ${result.name}\n${indent(result.log)}`);
        continue;
      }
      console.log(`  ok    ${result.name}`);
    }

    const scene = results.find((r) => r.name === 'scene');
    if (scene?.uniforms) {
      const active = new Set(scene.uniforms);
      const wanted = new Set(EXPECTED_UNIFORMS);
      const missing = [...wanted].filter((name) => !active.has(name));
      const extra = [...active].filter((name) => !wanted.has(name));
      if (missing.length || extra.length) {
        failed = true;
        if (missing.length) console.error(`  FAIL  the renderer sets these, the shader does not have them: ${missing.join(', ')}`);
        if (extra.length) console.error(`  FAIL  the shader has these, the renderer never sets them: ${extra.join(', ')}`);
      } else {
        console.log(`  ok    ${scene.uniforms.length} scene uniforms match the renderer`);
      }
    }
  } finally {
    await harness.close();
  }

  if (failed) {
    console.error('\nshaders: FAILED');
    process.exitCode = 1;
    return;
  }
  console.log('\nshaders: all programs compile, link, and agree with the renderer');
}

const indent = (text: string): string => text.split('\n').map((line) => `        ${line}`).join('\n');

await main();
