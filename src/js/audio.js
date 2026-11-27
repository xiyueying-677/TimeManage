let ctx = null;

function getCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  return ctx;
}

export function unlockAudio() {
  const ac = getCtx();
  if (ac && ac.state === "suspended") ac.resume().catch(() => {});
}

export function playChime(kind = "study", volume = 0.5) {
  const ac = getCtx();
  if (!ac) return;
  if (ac.state === "suspended") ac.resume().catch(() => {});
  const now = ac.currentTime + 0.02;
  const notes =
    kind === "study"
      ? [659.25, 783.99, 987.77]
      : kind === "countdown"
        ? [523.25, 659.25, 783.99, 1046.5]
        : [523.25, 659.25];
  const vol = Math.max(0, Math.min(1, volume)) * 0.7;
  notes.forEach((freq, i) => {
    const t = now + i * 0.17;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.62);
    osc.connect(gain);
    gain.connect(ac.destination);
    osc.start(t);
    osc.stop(t + 0.66);
  });
}
