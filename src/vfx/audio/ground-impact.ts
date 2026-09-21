import { AudioListener, PositionalAudio, Scene, Vector3 } from '@iwsdk/core';

const DURATION = 0.7;
const noiseBuffers = new WeakMap<BaseAudioContext, AudioBuffer>();

function getNoise(context: BaseAudioContext): AudioBuffer {
  let buf = noiseBuffers.get(context);
  if (!buf) {
    buf = context.createBuffer(1, Math.floor(context.sampleRate * 0.3), context.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    noiseBuffers.set(context, buf);
  }
  return buf;
}

// One-shot generative "something lands on soft ground". Deliberately NOT a
// kick-drum recipe (fast pitch sweep + hard click, identical every time — it
// read as a drum machine when stardust lands repeatedly): a soft-attack round
// thud with only a small pitch settle, an inharmonic woody overtone, and a
// noise-excited resonant "body" for the earthy tone. Every hit randomizes its
// pitch, resonance, length and level so no two land alike. Same raw-Web-Audio-
// via-PositionalAudio.setNodeSource technique as payoff-chime.ts. `pitch`
// scales the whole thing so repeated hits (moon bumps) can differ from planet
// hits.
export function playGroundImpact(
  listener: AudioListener,
  scene: Scene,
  position: Vector3,
  pitch = 1,
): void {
  const context = listener.context;
  if (context.state !== 'running') {
    context.resume().catch(() => {});
    return;
  }
  const now = context.currentTime + Math.random() * 0.015; // slight timing smear
  const sum = context.createGain();
  const character = 0.85 + Math.random() * 0.3; // per-hit pitch/resonance personality
  const level = 0.8 + Math.random() * 0.2;
  const f0 = 95 * pitch * character;

  // Round thud: gentle settle downward (not a kick's dive), soft attack.
  const thump = context.createOscillator();
  thump.type = 'sine';
  thump.frequency.setValueAtTime(f0, now);
  thump.frequency.exponentialRampToValueAtTime(f0 * 0.62, now + 0.2);
  const thumpGain = context.createGain();
  thumpGain.gain.setValueAtTime(0.0001, now);
  thumpGain.gain.exponentialRampToValueAtTime(0.3 * level, now + 0.016);
  thumpGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.38 + Math.random() * 0.14);
  thump.connect(thumpGain);
  thumpGain.connect(sum);
  thump.start(now);
  thump.stop(now + DURATION);

  // Woody overtone at a non-integer ratio — short, quiet; gives "material"
  // instead of a pure sub tone.
  const wood = context.createOscillator();
  wood.type = 'triangle';
  wood.frequency.setValueAtTime(f0 * (1.9 + Math.random() * 0.35), now);
  wood.frequency.exponentialRampToValueAtTime(f0 * 1.3, now + 0.14);
  const woodGain = context.createGain();
  woodGain.gain.setValueAtTime(0.0001, now);
  woodGain.gain.exponentialRampToValueAtTime(0.07 * level, now + 0.01);
  woodGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
  wood.connect(woodGain);
  woodGain.connect(sum);
  wood.start(now);
  wood.stop(now + 0.3);

  // Soft dusty scuff: low-passed noise with a slow-ish attack (no click).
  const noise = context.createBufferSource();
  noise.buffer = getNoise(context);
  const lp = context.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(700 * pitch, now);
  lp.frequency.exponentialRampToValueAtTime(140, now + 0.22);
  const noiseGain = context.createGain();
  noiseGain.gain.setValueAtTime(0.0001, now);
  noiseGain.gain.exponentialRampToValueAtTime(0.14 * level, now + 0.012);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
  noise.connect(lp);
  lp.connect(noiseGain);
  noiseGain.connect(sum);
  noise.start(now);
  noise.stop(now + 0.3);

  // Earthy body: the same kind of noise burst rung through a resonant band —
  // a hollow "thok" whose pitch varies per hit.
  const bodyNoise = context.createBufferSource();
  bodyNoise.buffer = getNoise(context);
  const bp = context.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(210 * pitch * character, now);
  bp.Q.setValueAtTime(4 + Math.random() * 3, now);
  const bodyGain = context.createGain();
  bodyGain.gain.setValueAtTime(0.0001, now);
  bodyGain.gain.exponentialRampToValueAtTime(0.32 * level, now + 0.01);
  bodyGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.26);
  bodyNoise.connect(bp);
  bp.connect(bodyGain);
  bodyGain.connect(sum);
  bodyNoise.start(now);
  bodyNoise.stop(now + 0.3);

  const sound = new PositionalAudio(listener);
  sound.setNodeSource(sum as unknown as AudioScheduledSourceNode);
  sound.position.copy(position);
  scene.add(sound);
  setTimeout(() => {
    scene.remove(sound);
    sum.disconnect();
  }, (DURATION + 0.1) * 1000);
}
