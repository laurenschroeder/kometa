import { AudioListener, PositionalAudio, Scene, Vector3 } from '@iwsdk/core';

const BASE_FREQ = 45; // Hz — low rumble at rest/start
const PEAK_FREQ = 190; // Hz — at max spin speed
const BASE_FILTER_CUTOFF = 90; // Hz
const PEAK_FILTER_CUTOFF = 500; // Hz
const PEAK_GAIN = 0.22;
const FADE_IN_SECONDS = 0.5;
const FADE_OUT_SECONDS = 0.15;

// A single sustained "engine rev-up" drone — unlike TwinkleSynth/PebbleSynth
// (fire-and-forget voice pools for discrete catch/pickup events), this is
// one continuous voice whose pitch/gain track PlanetSpinTransition's live
// angular speed for the whole spin window, then cuts off once it stops. Same
// raw-Web-Audio-via-PositionalAudio.setNodeSource technique as those two
// (IWSDK's AudioSource/AudioUtils layer is buffer-only, no generative-audio
// hook — see their identical comment). A low sawtooth oscillator (grit/
// richness) through a lowpass filter whose cutoff also rises with speed is
// what reads as "revving up" rather than a single clean tone sliding in pitch.
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
    this._oscillator.type = 'sawtooth';
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
  // (rises and falls with the actual spin rate, silent-ish at the very start
  // and end even mid-fade), progress is unused here but accepted for a
  // uniform call signature with the visual transition's own update().
  update(_progress: number, angularSpeedNorm: number): void {
    if (!this._running) return;
    const context = this._listener.context;
    const now = context.currentTime;
    const t = Math.max(0, Math.min(1, angularSpeedNorm));
    this._oscillator.frequency.linearRampToValueAtTime(BASE_FREQ + (PEAK_FREQ - BASE_FREQ) * t, now + 0.05);
    this._filter.frequency.linearRampToValueAtTime(
      BASE_FILTER_CUTOFF + (PEAK_FILTER_CUTOFF - BASE_FILTER_CUTOFF) * t,
      now + 0.05,
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
