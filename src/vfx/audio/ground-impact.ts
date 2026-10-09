import { AudioListener, PositionalAudio, Scene, Vector3 } from '@iwsdk/core';

const DURATION = 0.8;
const noiseBuffers = new WeakMap<BaseAudioContext, AudioBuffer>();

function getNoise(context: BaseAudioContext): AudioBuffer {
  let buf = noiseBuffers.get(context);
  if (!buf) {
    buf = context.createBuffer(1, Math.floor(context.sampleRate * 0.5), context.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    noiseBuffers.set(context, buf);
  }
  return buf;
}

// One short noise burst through a filter into `out` — the building block for
// every layer below. `offset` reads a different slice of the shared noise
// buffer so stacked layers don't sound phase-locked.
function noiseBurst(
  context: BaseAudioContext,
  out: AudioNode,
  start: number,
  filterType: BiquadFilterType,
  freq: number,
  q: number,
  peak: number,
  attack: number,
  decay: number,
): BiquadFilterNode {
  const src = context.createBufferSource();
  src.buffer = getNoise(context);
  const filter = context.createBiquadFilter();
  filter.type = filterType;
  filter.frequency.setValueAtTime(freq, start);
  filter.Q.setValueAtTime(q, start);
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + attack + decay);
  src.connect(filter);
  filter.connect(gain);
  gain.connect(out);
  src.start(start, Math.random() * 0.15);
  src.stop(start + attack + decay + 0.05);
  return filter;
}

// One-shot generative "a seed settles into soft soil". Deliberately has NO
// pitched oscillator: an earlier version's sine thump + pitch settle still
// read as a tom/drum when stardust lands repeatedly. Everything here is
// filtered noise, so it stays breathy and organic:
//  - a muffled low "pat" (soft earth giving way), slow-ish attack, no click
//  - a hollow seed-pod resonance that blooms slightly upward, like a soft
//    "pok" of something sinking in rather than something being struck
//  - a few scattered, quiet grains of dirt settling afterward
// Every hit randomizes pitch, resonance, grain timing and level so no two land
// alike. Same raw-Web-Audio-via-PositionalAudio.setNodeSource technique as
// payoff-chime.ts. `pitch` scales the whole thing so repeated hits (moon
// bumps) can differ from planet hits.
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
  const now = context.currentTime + Math.random() * 0.02; // slight timing smear
  const sum = context.createGain();
  sum.gain.value = 0.85;
  const character = 0.85 + Math.random() * 0.3; // per-hit pitch/resonance personality
  const level = 0.75 + Math.random() * 0.25;

  // Muffled soil "pat": heavily low-passed noise, gentle attack.
  noiseBurst(context, sum, now, 'lowpass', 260 * pitch * character, 0.7, 0.34 * level, 0.028, 0.3 + Math.random() * 0.1);

  // Hollow seed-pod resonance, blooming a little upward as it fades.
  const podFreq = 300 * pitch * character;
  const pod = noiseBurst(context, sum, now + 0.005, 'bandpass', podFreq, 7 + Math.random() * 4, 0.22 * level, 0.022, 0.24);
  pod.frequency.exponentialRampToValueAtTime(podFreq * (1.12 + Math.random() * 0.1), now + 0.22);

  // Grains of dirt settling: a few tiny, quiet, scattered ticks.
  const grains = 3 + Math.floor(Math.random() * 3);
  for (let i = 0; i < grains; i++) {
    const t = now + 0.04 + Math.random() * 0.22;
    noiseBurst(
      context,
      sum,
      t,
      'bandpass',
      (1400 + Math.random() * 1600) * pitch,
      2.5,
      (0.025 + Math.random() * 0.025) * level,
      0.004,
      0.03 + Math.random() * 0.03,
    );
  }

  const sound = new PositionalAudio(listener);
  sound.setNodeSource(sum as unknown as AudioScheduledSourceNode);
  sound.position.copy(position);
  scene.add(sound);
  setTimeout(() => {
    scene.remove(sound);
    sum.disconnect();
  }, (DURATION + 0.1) * 1000);
}
