// Aurora DSP utilities.

export function clamp(v: number, min: number, max: number): number {
  // NaN gets the bottom of the range: a dead reading must not ride the fader
  // to the top or slip through the limiter's arithmetic as NaN.
  if (Number.isNaN(v)) return min;
  return Math.min(max, Math.max(min, v));
}

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

export function gainToDb(gain: number): number {
  return 20 * Math.log10(Math.max(1e-10, gain));
}

export function saturationCurve(amount = 0.3, points = 1024): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(points);
  const k = Math.max(0.0001, amount) * 4;
  for (let i = 0; i < points; i++) {
    const x = (i / (points - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / Math.tanh(k);
  }
  return curve;
}

export function createNoiseBuffer(ctx: BaseAudioContext, channels = 2, seconds = 5): AudioBuffer {
  const buffer = ctx.createBuffer(channels, ctx.sampleRate * seconds, ctx.sampleRate);
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  return buffer;
}

export function createReverbImpulse(ctx: BaseAudioContext, seconds = 4): AudioBuffer {
  const rate = ctx.sampleRate;
  const length = rate * seconds;
  const buffer = ctx.createBuffer(2, length, rate);
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < length; i++) {
      const t = i / rate;
      const envelope = Math.pow(1 - t / seconds, 2);
      data[i] = (Math.random() * 2 - 1) * envelope * 0.5;
    }
  }
  return buffer;
}