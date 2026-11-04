/** Tiny Web Audio effects: a metallic "clink" for buys, a lower tone for sells, a chime for launches. */
let ctx: AudioContext | null = null;

export function playSfx(kind: "buy" | "sell" | "launch" = "buy") {
  try {
    ctx ??= new AudioContext();
    const t0 = ctx.currentTime;
    const notes = kind === "sell" ? [880, 659] : kind === "launch" ? [784, 988, 1319] : [1319, 1976];
    notes.forEach((f, i) => {
      const at = t0 + i * 0.06;
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      osc.type = "sine";
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.07, at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
      osc.connect(gain).connect(ctx!.destination);
      osc.start(at);
      osc.stop(at + 0.4);
    });
  } catch {
    // Audio unavailable (no user gesture yet, or no device): stay silent.
  }
}
