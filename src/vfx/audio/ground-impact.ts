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

// One-shot generative "something lands on soft ground": a pitch-dropping sine
// thump plus a low-passed noise burst for the dusty crunch. Same raw-Web-Audio-
// via-PositionalAudio.setNodeSource technique as payoff-chime.ts. `pitch`
// scales the thump so repeated hits (moon bumps) can differ from planet hits.
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
  const now = context.currentTime;
  const sum = context.createGain();

  const thump = context.createOscillator();
  thump.type = 'sine';
  thump.frequency.setValueAtTime(140 * pitch * (0.95 + Math.random() * 0.1), now);
  thump.frequency.exponentialRampToValueAtTime(42 * pitch, now + 0.25);
  const thumpGain = context.createGain();
  thumpGain.gain.setValueAtTime(0.0001, now);
  thumpGain.gain.exponentialRampToValueAtTime(0.35, now + 0.008);
  thumpGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
  thump.connect(thumpGain);
  thumpGain.connect(sum);
  thump.start(now);
  thump.stop(now + DURATION);

  const noise = context.createBufferSource();
  noise.buffer = getNoise(context);
  const lp = context.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(1800 * pitch, now);
  lp.frequency.exponentialRampToValueAtTime(200, now + 0.25);
  const noiseGain = context.createGain();
  noiseGain.gain.setValueAtTime(0.0001, now);
  noiseGain.gain.exponentialRampToValueAtTime(0.25, now + 0.004);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
  noise.connect(lp);
  lp.connect(noiseGain);
  noiseGain.connect(sum);
  noise.start(now);
  noise.stop(now + 0.3);

  const sound = new PositionalAudio(listener);
  sound.setNodeSource(sum as unknown as AudioScheduledSourceNode);
  sound.position.copy(position);
  scene.add(sound);
  setTimeout(() => {
    scene.remove(sound);
    sum.disconnect();
  }, (DURATION + 0.1) * 1000);
}
