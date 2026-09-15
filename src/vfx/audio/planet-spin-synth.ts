import { AudioListener, PositionalAudio, Scene, Vector3 } from '@iwsdk/core';

// Pulled the whole range in and swapped sawtooth for triangle (see below) —
// the old 45->190Hz sawtooth sweep read as a toy engine revving rather than
// a planet slowly turning through a "many years later" montage. A narrower
// sweep on a softer waveform reads as a low ambient swell instead.
const BASE_FREQ = 55; // Hz — low rumble at rest/start
const PEAK_FREQ = 110; // Hz — at max spin speed
const BASE_FILTER_CUTOFF = 90; // Hz
const PEAK_FILTER_CUTOFF = 260; // Hz
const PEAK_GAIN = 0.16;
const FADE_IN_SECONDS = 0.8;
const FADE_OUT_SECONDS = 0.3;
// Portamento smoothing for the pitch/filter ramps in update() — slower than
// the old 0.05s snap, so speed changes glide rather than chase every small
// per-frame wobble in angularSpeedNorm, another piece of the "engine rev"
// character this is deliberately moving away from.
const RAMP_SMOOTHING_SECONDS = 0.25;

// A single sustained ambient drone — unlike TwinkleSynth/PebbleSynth
// (fire-and-forget voice pools for discrete catch/pickup events), this is
// one continuous voice whose pitch/gain track PlanetSpinTransition's live
// angular speed for the whole spin window, then cuts off once it stops. Same
// raw-Web-Audio-via-PositionalAudio.setNodeSource technique as those two
// (IWSDK's AudioSource/AudioUtils layer is buffer-only, no generative-audio
// hook — see their identical comment). A low triangle oscillator (softer,
// less buzzy than the sawtooth this used to be) through a lowpass filter
// whose cutoff also rises gently with speed — a subtle swell rather than a
// cartoonish "revving" engine.
export class PlanetSpinSynth {
  private _listener!: AudioListener;
  private _scene!: Scene;
  private _oscillator!: OscillatorNode;
  private _filter!: BiquadFilterNode;
  private _gain!: GainNode;
  private _sound!: PositionalAudio;
  private _running = false;

  build(listener: AudioListener, scene: Scene): void {
    this._listener = listener;
    this._scene = scene;
    listener.context.resume().catch(() => {});
  }

  start(position: Vector3): void {
    const context = this._listener.context;
    if (context.state !== 'running') {
      context.resume().catch(() => {});
      return;
    }
    this.stop();

    const now = context.currentTime;
    this._oscillator = context.createOscillator();
    this._oscillator.type = 'triangle';
    this._oscillator.frequency.setValueAtTime(BASE_FREQ, now);

    this._filter = context.createBiquadFilter();
    this._filter.type = 'lowpass';
    this._filter.frequency.setValueAtTime(BASE_FILTER_CUTOFF, now);
    this._filter.Q.value = 1.5;

    this._gain = context.createGain();
    this._gain.gain.setValueAtTime(0, now);
    this._gain.gain.linearRampToValueAtTime(PEAK_GAIN, now + FADE_IN_SECONDS);

    this._oscillator.connect(this._filter);
    this._filter.connect(this._gain);

    this._sound = new PositionalAudio(this._listener);
    this._sound.setNodeSource(this._gain as unknown as AudioScheduledSourceNode);
    this._sound.position.copy(position);
    this._scene.add(this._sound);

    this._oscillator.start(now);
    this._running = true;
  }

  // Called every frame while PlanetSpinTransition is active. progress/
  // angularSpeedNorm are both 0-1 (see PlanetSpinTransition.getProgress/
  // getAngularSpeedNorm) — angularSpeedNorm drives the rumble's intensity
  // (rises with the actual spin rate and holds near peak through most of the
  // transition, only easing back down right at the very end — see
  // spinEnvelope's own comment), progress is unused here but accepted for a
  // uniform call signature with the visual transition's own update().
  update(_progress: number, angularSpeedNorm: number): void {
    if (!this._running) return;
    const context = this._listener.context;
    const now = context.currentTime;
    const t = Math.max(0, Math.min(1, angularSpeedNorm));
    // cancelScheduledValues + setValueAtTime(currentValue) before each ramp
    // is required here — without it, every one of these per-frame calls
    // stacks ANOTHER automation event onto the param's timeline instead of
    // replacing the in-flight ramp (Web Audio never discards old automation
    // points on its own). Over this synth's full ~11s run at 72-90fps that
    // silently built up 800+ live automation points per param for the audio
    // engine to keep evaluating every render quantum — a real, escalating
    // cost for the whole spin, not just a one-frame hitch. Cancelling first
    // collapses each param back down to exactly one live ramp at a time.
    this._oscillator.frequency.cancelScheduledValues(now);
    this._oscillator.frequency.setValueAtTime(this._oscillator.frequency.value, now);
    this._oscillator.frequency.linearRampToValueAtTime(
      BASE_FREQ + (PEAK_FREQ - BASE_FREQ) * t,
      now + RAMP_SMOOTHING_SECONDS,
    );
    this._filter.frequency.cancelScheduledValues(now);
    this._filter.frequency.setValueAtTime(this._filter.frequency.value, now);
    this._filter.frequency.linearRampToValueAtTime(
      BASE_FILTER_CUTOFF + (PEAK_FILTER_CUTOFF - BASE_FILTER_CUTOFF) * t,
      now + RAMP_SMOOTHING_SECONDS,
    );
  }

  // Fades out and hard-stops. Safe to call even if never started (e.g. a
  // fresh loop reset before the spin ever ran).
  stop(): void {
    if (!this._running) return;
    this._running = false;
    const context = this._listener.context;
    const now = context.currentTime;
    const osc = this._oscillator;
    const gain = this._gain;
    const sound = this._sound;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + FADE_OUT_SECONDS);
    osc.stop(now + FADE_OUT_SECONDS + 0.02);
    setTimeout(() => {
      this._scene.remove(sound);
      gain.disconnect();
    }, (FADE_OUT_SECONDS + 0.05) * 1000);
  }
}
