// Aurora UI: the enter screen, the HUD, and the controls behind the Options
// drawer. It renders state and forwards intent; all state that matters lives
// in main.ts, so there is nothing here to keep in sync.

import type { Quality } from './types.ts';

export interface HUDInfo {
  section: string;
  bpm: string;
  bar: number;
  key: string;
  chord: string;
  palette: string;
}

export interface HUDStats {
  lufs: string;
  peak: string;
  voices: number;
  fps: number;
  scale: string;
}

export interface UI {
  setInfo(info: HUDInfo): void;
  setAsleep(asleep: boolean): void;
  hud: { set(stats: HUDStats): void };
}

export interface UIOptions {
  seed: string;
  onStart: () => void;
  onAudioOnly: (audioOnly: boolean) => void;
  onFlashMode: (mode: 'soft' | 'full') => void;
  onQuality: (quality: Quality) => void;
  onVolume: (volume: number) => void;
  onSleep: (seconds: number) => void;
}

/** The sleep timer's UI steps, in minutes; the hook can arm shorter ones. */
const SLEEP_MINUTES = [15, 30, 60, 120] as const;

export function initUI(opts: UIOptions): UI {
  const { seed, onStart, onAudioOnly, onFlashMode, onQuality, onVolume, onSleep } = opts;

  const enter = mustElement<HTMLDivElement>('enter');
  const hud = mustElement<HTMLDivElement>('hud');
  const seedLine = mustElement<HTMLParagraphElement>('seed-line');
  const startBtn = mustElement<HTMLButtonElement>('start');
  const audioOnlyBtn = mustElement<HTMLButtonElement>('audio-only');
  const reducedMotion = mustElement<HTMLInputElement>('reduced-motion');
  const flashFull = mustElement<HTMLInputElement>('flash-full');
  const qualitySelect = mustElement<HTMLSelectElement>('quality');
  const volumeRange = mustElement<HTMLInputElement>('volume');
  const options = mustElement<HTMLDetailsElement>('options');

  seedLine.textContent = `set seed: ${seed}`;
  qualitySelect.value = 'auto';
  volumeRange.value = String(0.7);

  let audioOnly = false;

  function showHUD(): void {
    enter.classList.add('hidden');
    hud.classList.remove('hidden');
  }

  startBtn.addEventListener('click', () => {
    showHUD();
    onStart();
  });

  audioOnlyBtn.addEventListener('click', () => {
    audioOnly = !audioOnly;
    onAudioOnly(audioOnly);
    audioOnlyBtn.textContent = audioOnly ? 'Audio + Visual' : 'Audio only';
  });

  // Reduced motion is the accessibility door in: it forces the soft flash
  // mode and locks the opt-in full flash behind it.
  reducedMotion.addEventListener('change', () => {
    if (reducedMotion.checked) {
      flashFull.checked = false;
      flashFull.disabled = true;
      onFlashMode('soft');
    } else {
      flashFull.disabled = false;
    }
  });

  flashFull.addEventListener('change', () => {
    onFlashMode(flashFull.checked ? 'full' : 'soft');
  });

  qualitySelect.addEventListener('change', () => {
    onQuality(qualitySelect.value as Quality);
  });

  volumeRange.addEventListener('input', () => {
    onVolume(parseFloat(volumeRange.value));
  });

  // The sleep timer: one button per step, plus a cancel. The hook
  // (__aurora.armSleep) can arm shorter timers than these.
  for (const minutes of SLEEP_MINUTES) {
    const btn = document.createElement('button');
    btn.textContent = `Sleep ${minutes}m`;
    btn.addEventListener('click', () => onSleep(minutes * 60));
    options.appendChild(btn);
  }
  const cancelSleep = document.createElement('button');
  cancelSleep.textContent = 'Cancel sleep';
  cancelSleep.addEventListener('click', () => onSleep(0));
  options.appendChild(cancelSleep);

  const info = document.createElement('div');
  hud.appendChild(info);
  const statsLine = document.createElement('div');
  statsLine.setAttribute('data-stats', '');
  hud.appendChild(statsLine);

  return {
    setInfo(piece: HUDInfo): void {
      info.innerHTML = `
        <div>${escapeHtml(piece.section.toUpperCase())}</div>
        <div>${escapeHtml(piece.bpm)} | Bar ${piece.bar}</div>
        <div>${escapeHtml(piece.key)} | ${escapeHtml(piece.chord)}</div>
        <div>Palette: ${escapeHtml(piece.palette)}</div>
      `;
    },
    setAsleep(asleep: boolean): void {
      info.querySelector('[data-asleep]')?.remove();
      if (asleep) {
        const note = document.createElement('div');
        note.setAttribute('data-asleep', '');
        note.textContent = '💤 Sleeping — click to wake the set';
        info.appendChild(note);
      }
    },
    hud: {
      set(stats: HUDStats): void {
        statsLine.textContent =
          `${stats.lufs} LUFS | ${stats.peak} dBTP | ${stats.voices}v | ${stats.fps}fps | ${stats.scale}`;
      },
    },
  };
}

function mustElement<T extends Element>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`#${id} not found`);
  // The ids are this file's own constants; the assertion is the contract.
  return element as unknown as T;
}

/** HUD text is app-generated (section, key, chord names), never user input —
 * escaped anyway so a future rename cannot turn a label into markup. */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
