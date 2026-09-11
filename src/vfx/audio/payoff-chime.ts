import { AudioListener, PositionalAudio, Scene, Vector3 } from '@iwsdk/core';

const RATIOS = [1.0, 1.5, 2.0];
const ATTACK = 0.02;
const DECAY = 1.2;
const GAIN = 0.09;

// Small shared one-shot "resolving chime" — same raw-Web-Audio-via-
// PositionalAudio.setNodeSource technique every other generative cue in this
// codebase uses (see crown-rise.ts/ghost-rise.ts's own _settleAscension),
// minus those files' sustained shimmer/reverb send — just the one-shot
// triad burst. Built for Fate Events' Beat 5 payoff cues (organic blossom,
// Gas banner, Soul dance), where three near-identical sustained-drone rigs
// would be pure duplication.
export function playPayoffChime(listener: AudioListener, scene: Scene, position: Vector3, baseFreq: number): void {
  const context = listener.context;
  if (context.state !== 'running') {
    context.resume().catch(() => {});
    return;
  }
  const now = context.currentTime;
  const sum = context.createGain();
  sum.gain.value = 1;
  for (const ratio of RATIOS) {
    const osc = context.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = baseFreq * ratio;
    const g = context.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(GAIN, now + ATTACK);
    g.gain.exponentialRampToValueAtTime(0.0001, now + ATTACK + DECAY);
    osc.connect(g);
    g.connect(sum);
    osc.start(now);
    osc.stop(now + ATTACK + DECAY + 0.05);
  }
  const sound = new PositionalAudio(listener);
  sound.setNodeSource(sum as unknown as AudioScheduledSourceNode);
  sound.position.copy(position);
  scene.add(sound);
  setTimeout(() => {
    scene.remove(sound);
    sum.disconnect();
  }, (ATTACK + DECAY + 0.1) * 1000);
}
