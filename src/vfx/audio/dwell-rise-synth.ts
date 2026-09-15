import { AudioListener, PositionalAudio, Scene, Vector3 } from '@iwsdk/core';

// A sustained rising tone while a person in Fate Events' crowd is mid-turn
// toward the player (see FateEventSystem._updateCollect's _turnAmount) —
// same persistent-oscillator start/update/stop idiom as OrbitalLaunchSynth's
// own charge-rise tone (see its own class comment), just a single fixed
// root rather than a per-choice one, since there's no "commit chord" this
// hands off to here. Gives the dwell itself an audible sense of "something
// is building" instead of a silent wait, now that the wait is long enough
// (see TURN_IN_SECONDS) to actually need one.
const ROOT_FREQ = 300;
const START_RATIO = 0.6; // starts a bit below the root, rises to it at t=1
const FADE_IN_SECONDS = 0.15;
const FADE_OUT_SECONDS = 0.2;
const BASE_GAIN = 0.015;
const PEAK_GAIN = 0.09;

export class DwellRiseSynth {
  private _listener!: AudioListener;
  private _scene!: Scene;

  private _osc!: OscillatorNode;
  private _gain!: GainNode;
  private _sound!: PositionalAudio;
  private _running = false;

  build(listener: AudioListener, scene: Scene): void {
    this._listener = listener;
    this._scene = scene;
    listener.context.resume().catch(() => {});
  }

  // Starts (or restarts, if already running) the rising tone at `position`.
  start(position: Vector3): void {
    const context = this._listener.context;
    if (context.state !== 'running') {
      context.resume().catch(() => {});
      return;
    }
    this._stopImmediate();

    const now = context.currentTime;
    this._osc = context.createOscillator();
    this._osc.type = 'sine';
    this._osc.frequency.setValueAtTime(ROOT_FREQ * START_RATIO, now);

    this._gain = context.createGain();
    this._gain.gain.setValueAtTime(0, now);
    this._gain.gain.linearRampToValueAtTime(BASE_GAIN, now + FADE_IN_SECONDS);
    this._osc.connect(this._gain);

    this._sound = new PositionalAudio(this._listener);
    this._sound.setNodeSource(this._gain as unknown as AudioScheduledSourceNode);
    this._sound.position.copy(position);
    this._scene.add(this._sound);

    this._osc.start(now);
    this._running = true;
  }

  // Called every frame the dwell is progressing — t01 (0-1, the turning
  // person's own _turnAmount) drives both pitch and gain, so the tone
  // audibly builds toward the moment they finish turning.
  update(t01: number, position: Vector3): void {
    if (!this._running) return;
    const context = this._listener.context;
    const now = context.currentTime;
    const t = Math.max(0, Math.min(1, t01));
    const freq = ROOT_FREQ * (START_RATIO + (1 - START_RATIO) * t);
    this._osc.frequency.linearRampToValueAtTime(freq, now + 0.05);
    this._gain.gain.linearRampToValueAtTime(BASE_GAIN + (PEAK_GAIN - BASE_GAIN) * t, now + 0.05);
    this._sound.position.copy(position);
  }

  // Fades out and stops — called once nobody is currently mid-turn. Safe to
  // call even if never started.
  stop(): void {
    if (!this._running) return;
    this._running = false;
    const context = this._listener.context;
    const now = context.currentTime;
    const osc = this._osc;
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

  // Hard-cut variant for start()'s own restart-guard — switching to a
  // different rising person mid-dwell should cut cleanly rather than
  // crossfading two rising pitches.
  private _stopImmediate(): void {
    if (!this._running) return;
    this._running = false;
    this._osc.stop();
    this._scene.remove(this._sound);
    this._gain.disconnect();
  }
}
