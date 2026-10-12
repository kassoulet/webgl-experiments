// The diagnostic hook's type: what `__aurora` is on a page running aurora.
// The smoke test (tools/smoke.ts) drives everything through this, so its shape
// is the app's contract with its own tests — keep it boring and keep it true.

import type { AuroraConductorState, DescribedPiece } from './types.ts';
import type { Conductor } from './conductor.ts';
import type { Engine } from './audio/engine.ts';
import type { Renderer, DrawOptions } from './visuals/renderer.ts';

export interface AuroraDebug {
  conductor: Conductor;
  engine: Engine;
  renderer: Renderer;
  /** Pin the picture to a moment (or unpin with no arguments). */
  draw: (options?: DrawOptions) => void;
  /** Offline loudness probe: the conductor + patterns, rendered and measured. */
  offline: (options?: { seed?: string; seconds?: number; measureFrom?: number }) => Promise<unknown>;
  /** Everything a soak samples, in one read. */
  stats: () => {
    started: boolean;
    asleep: boolean;
    clock: number;
    frames: number;
    audio: ReturnType<Engine['getStats']>;
    render: Renderer['getStats'] extends (...a: never[]) => infer R ? R : never;
  };
  pieceAt: (t: number) => DescribedPiece;
  stateAt: (t: number) => AuroraConductorState;
  armSleep: (seconds: number) => void;
  getSeed: () => string;
  setSeed: (seed: string) => void;
}

declare global {
  // eslint-disable-next-line no-var
  var __aurora: AuroraDebug | undefined;
}
