// The interface: the controls, the readout and the rule that it stays out of the
// way — visible while the pointer moves, gone a few seconds after it stops.
//
// The DOM here is fixed by index.html, so a missing element is a build-time
// mistake rather than a runtime state: `must` says so loudly instead of
// scattering null checks through the app.

const HIDE_AFTER_MS = 4200;

/** What the app tells the interface. */
export interface UIHandlers {
  onEnter?: () => void;
  onNewSeed?: () => void;
  onCopyLink?: () => void;
  onVolume?: (volume: number) => void;
  onQuality?: (quality: string) => void;
  onFlash?: (mode: string) => void;
  onAudioOnly?: (on: boolean) => void;
  onSleep?: (minutes: number) => void;
  onSeed?: (seed: string) => void;
  onNoticeAction?: () => void;
}

/** The short description of the set the HUD shows. */
export interface UIInfo {
  section: string;
  bpm: string;
  chord: string;
  next: string;
  bars: string;
}

export interface UIStats {
  fps?: number;
  scale?: number;
  /** Points the oscilloscope trace is being drawn from. Zero means there is no
   *  analyser, and saying so is more use than a dash. */
  scopeBins?: number;
  /** How much light is in the frame. On a picture that is two-thirds black this
   *  is the number that says whether the scope is actually on the screen. */
  mean?: number;
  lufs?: number;
  truePeakDb?: number;
  voices?: number;
  mode?: string;
}

export interface UI {
  enter(): void;
  setSeed(seed: string): void;
  setInfo(info: UIInfo): void;
  setStats(stats: UIStats): void;
  setVolume(value: number): void;
  setSleep(minutes: number): void;
  toast(message: string): void;
  notice(text: string, actionLabel?: string | null): void;
  hideNotice(): void;
  setAudioOnly(on: boolean): void;
  hudVisible(): boolean;
}

function must<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`[ui] index.html is missing #${id}`);
  return element as T;
}

export function initUI(handlers: UIHandlers = {}): UI {
  const enter = must<HTMLElement>('enter');
  const hud = must<HTMLElement>('hud');
  const toastEl = must<HTMLElement>('toast');
  const noticeEl = must<HTMLElement>('notice');
  const noticeText = must<HTMLElement>('notice-text');
  const noticeAction = must<HTMLButtonElement>('notice-action');
  const volume = must<HTMLInputElement>('volume');
  const quality = must<HTMLSelectElement>('quality');
  const flash = must<HTMLSelectElement>('flash');
  const audioOnly = must<HTMLInputElement>('audio-only');
  const sleep = must<HTMLSelectElement>('sleep');
  const seedInput = must<HTMLInputElement>('seed');
  const statsEl = must<HTMLElement>('stats');
  const enterSeed = must<HTMLElement>('enter-seed');
  const readout = {
    section: must<HTMLElement>('readout-section'),
    bpm: must<HTMLElement>('readout-bpm'),
    chord: must<HTMLElement>('readout-chord'),
    bars: must<HTMLElement>('readout-bars'),
  };

  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;

  function showHud(): void {
    hud.classList.add('visible');
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => hud.classList.remove('visible'), HIDE_AFTER_MS);
  }

  for (const event of ['pointermove', 'pointerdown', 'keydown', 'touchstart']) {
    window.addEventListener(event, showHud, { passive: true });
  }

  enterSeed.textContent = seedInput.value || '—';
  must<HTMLButtonElement>('enter-button').addEventListener('click', () => handlers.onEnter?.());
  must<HTMLButtonElement>('new-seed').addEventListener('click', () => handlers.onNewSeed?.());
  must<HTMLButtonElement>('copy-link').addEventListener('click', () => handlers.onCopyLink?.());

  volume.addEventListener('input', () => handlers.onVolume?.(Number(volume.value)));
  quality.addEventListener('change', () => handlers.onQuality?.(quality.value));
  flash.addEventListener('change', () => handlers.onFlash?.(flash.value));
  audioOnly.addEventListener('change', () => handlers.onAudioOnly?.(audioOnly.checked));
  sleep.addEventListener('change', () => handlers.onSleep?.(Number(sleep.value)));
  seedInput.addEventListener('change', () => handlers.onSeed?.(seedInput.value));
  seedInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      seedInput.blur();
      handlers.onSeed?.(seedInput.value);
    }
  });

  noticeAction.addEventListener('click', () => handlers.onNoticeAction?.());

  return {
    enter() {
      enter.classList.add('hidden');
      hud.setAttribute('aria-hidden', 'false');
      showHud();
    },
    setSeed(seed) {
      seedInput.value = seed;
      enterSeed.textContent = seed;
    },
    setInfo(info) {
      readout.section.textContent = info.section;
      readout.bpm.textContent = info.bpm;
      readout.chord.textContent = `${info.chord} → ${info.next}`;
      readout.bars.textContent = info.bars;
    },
    setStats(stats) {
      const parts: string[] = [];
      if (stats.fps) parts.push(`${stats.fps} fps`);
      if (stats.scale) parts.push(`×${stats.scale}`);
      // Zero is a real answer here, not a missing one: no analyser means no
      // trace, and the honest thing to put on screen is "no scope".
      if (stats.scopeBins != null) parts.push(stats.scopeBins ? `scope ${stats.scopeBins}` : 'no scope');
      if (stats.mean != null) parts.push(`frame ${stats.mean.toFixed(3)}`);
      if (stats.lufs != null && Number.isFinite(stats.lufs)) parts.push(`${stats.lufs.toFixed(1)} LUFS`);
      if (stats.truePeakDb != null && Number.isFinite(stats.truePeakDb)) {
        parts.push(`${stats.truePeakDb.toFixed(1)} dBTP`);
      }
      if (stats.voices) parts.push(`${stats.voices} voices`);
      if (stats.mode) parts.push(stats.mode);
      statsEl.textContent = parts.join('  ·  ');
    },
    setVolume(value) {
      volume.value = String(value);
    },
    setSleep(minutes) {
      sleep.value = String(minutes);
    },
    toast(message) {
      toastEl.textContent = message;
      toastEl.classList.add('visible');
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toastEl.classList.remove('visible'), 2600);
    },
    notice(text, actionLabel = null) {
      noticeText.textContent = text;
      if (actionLabel) {
        noticeAction.textContent = actionLabel;
        noticeAction.hidden = false;
      } else {
        noticeAction.hidden = true;
      }
      noticeEl.hidden = false;
    },
    hideNotice() {
      noticeEl.hidden = true;
    },
    setAudioOnly(on) {
      audioOnly.checked = Boolean(on);
    },
    hudVisible: () => hud.classList.contains('visible'),
  };
}
