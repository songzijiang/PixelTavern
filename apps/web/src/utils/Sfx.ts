let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (ctx) return ctx;
  try {
    ctx = new AudioContext();
    return ctx;
  } catch {
    return null;
  }
}

function playTone(freq: number, duration: number, type: OscillatorType = 'sine', vol = 0.08) {
  const c = getCtx();
  if (!c) return;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(vol, c.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + duration);
  osc.connect(gain);
  gain.connect(c.destination);
  osc.start(c.currentTime);
  osc.stop(c.currentTime + duration);
}

export function sfxClick() { playTone(800, 0.06, 'sine', 0.06); }
export function sfxTab() { playTone(600, 0.08, 'triangle', 0.05); }
export function sfxToggle() { playTone(500, 0.04, 'square', 0.03); playTone(700, 0.04, 'square', 0.03); }
export function sfxSave() { playTone(900, 0.05, 'sine', 0.06); setTimeout(() => playTone(1100, 0.07, 'sine', 0.06), 60); }
export function sfxDelete() { playTone(300, 0.1, 'sawtooth', 0.04); }
export function sfxHover() { playTone(1200, 0.03, 'sine', 0.02); }
