import { seppukuImpact } from "./seppuku-timing.ts";

export type SoundCue =
  | "swing"
  | "shot"
  | "hit"
  | "shield"
  | "hurt"
  | "stamina"
  | "kill"
  | "death"
  | "countdown"
  | "start"
  | "victory"
  | "defeat"
  | "draw"
  | "seppuku";

export interface SoundSettings {
  enabled: boolean;
  volume: number;
  seppuku: boolean;
}

export const soundSettingsKey = "korovany.arena.sound.v1";
export const defaultSoundSettings: SoundSettings = {
  enabled: true,
  volume: 0.45,
  seppuku: true,
};

export function readSoundSettings(
  storage: Pick<Storage, "getItem">,
): SoundSettings {
  try {
    const value = JSON.parse(storage.getItem(soundSettingsKey) ?? "null");
    return {
      enabled: typeof value?.enabled === "boolean" ? value.enabled : true,
      volume:
        typeof value?.volume === "number" && Number.isFinite(value.volume)
          ? Math.max(0, Math.min(1, value.volume))
          : defaultSoundSettings.volume,
      seppuku: typeof value?.seppuku === "boolean" ? value.seppuku : true,
    };
  } catch {
    return { ...defaultSoundSettings };
  }
}

type Wave = OscillatorType | "noise";
// Start time, duration, start/end pitch (noise: filter cutoff), level, waveform.
type Note = readonly [number, number, number, number, number, Wave];
const melodies = (notes: number[], step: number, length: number): Note[] =>
  notes.map((frequency, i) => [
    i * step,
    i === notes.length - 1 ? length : step * 0.85,
    frequency,
    frequency,
    0.065,
    "square",
  ]);

const score: Record<SoundCue, readonly Note[]> = {
  swing: [
    [0, 0.13, 5200, 700, 0.1, "noise"],
    [0.01, 0.09, 210, 90, 0.035, "triangle"],
  ],
  shot: [
    [0, 0.16, 880, 220, 0.09, "triangle"],
    [0, 0.07, 4200, 1300, 0.05, "noise"],
  ],
  hit: [
    [0, 0.1, 160, 55, 0.13, "square"],
    [0, 0.065, 2400, 600, 0.1, "noise"],
  ],
  shield: [
    [0, 0.16, 1568, 1047, 0.065, "square"],
    [0.012, 0.12, 2349, 1760, 0.035, "square"],
    [0, 0.045, 6500, 3000, 0.065, "noise"],
  ],
  hurt: [
    [0, 0.24, 110, 36, 0.16, "triangle"],
    [0, 0.13, 650, 120, 0.085, "noise"],
  ],
  stamina: [
    [0, 0.07, 196, 196, 0.055, "square"],
    [0.13, 0.09, 147, 147, 0.055, "square"],
  ],
  kill: melodies([523.25, 659.25, 783.99], 0.085, 0.2),
  death: melodies([220, 174.61, 130.81, 65.41], 0.15, 0.45),
  countdown: [[0, 0.09, 440, 440, 0.07, "square"]],
  start: melodies([392, 523.25, 783.99], 0.09, 0.3),
  victory: [
    ...melodies(
      [392, 523.25, 659.25, 783.99, 659.25, 783.99, 1046.5],
      0.22,
      0.7,
    ),
    [0, 0.5, 130.81, 130.81, 0.075, "triangle"],
    [0.66, 0.5, 196, 196, 0.07, "triangle"],
    [1.32, 0.7, 261.63, 261.63, 0.07, "triangle"],
  ],
  defeat: [
    ...melodies([392, 349.23, 311.13, 261.63, 196], 0.3, 0.7),
    [0, 0.8, 98, 98, 0.07, "triangle"],
    [0.9, 1.0, 65.41, 65.41, 0.07, "triangle"],
  ],
  draw: melodies([392, 523.25, 392], 0.2, 0.5),
  seppuku: [
    [0.12, 0.4, 90, 34, 0.16, "sine"],
    [0.85, 0.4, 80, 32, 0.18, "sine"],
    [1.5, 0.5, 440, 1200, 0.018, "triangle"],
    [seppukuImpact, 0.9, 135, 25, 0.28, "sine"],
    [seppukuImpact, 0.22, 1300, 180, 0.055, "triangle"],
    [2.3, 1.8, 110, 55, 0.075, "sine"],
  ],
};

interface Voice {
  source: AudioScheduledSourceNode;
  gain: GainNode;
  filter?: BiquadFilterNode;
  start: number;
  cue: SoundCue | "bow";
}

/** Small local synth: no files, timers, or sounds queued while audio is locked. */
export class ArenaAudio {
  private context?: AudioContext;
  private master?: GainNode;
  private noise?: AudioBuffer;
  private voices = new Set<Voice>();
  private lastPlayed = new Map<SoundCue, number>();
  private focused = true;
  private bow?: Voice;
  private drawing = false;
  settings = { ...defaultSoundSettings };

  constructor() {
    try {
      this.settings = readSoundSettings(localStorage);
    } catch {
      /* Storage may be disabled. */
    }
  }

  unlock() {
    if (!this.settings.enabled || !this.focused) return;
    try {
      if (!this.context) {
        const context = new AudioContext();
        this.context = context;
        this.master = context.createGain();
        const limiter = context.createDynamicsCompressor();
        limiter.threshold.value = -14;
        limiter.knee.value = 12;
        limiter.ratio.value = 8;
        limiter.attack.value = 0.003;
        limiter.release.value = 0.15;
        limiter.connect(this.master).connect(context.destination);
        this.output = limiter;
        this.master.gain.value = this.settings.volume ** 2;
        this.noise = context.createBuffer(
          1,
          context.sampleRate,
          context.sampleRate,
        );
        const data = this.noise.getChannelData(0);
        let register = 1;
        for (let i = 0; i < data.length; i++) {
          if (i % 4 === 0)
            register =
              (register >> 1) | (((register ^ (register >> 1)) & 1) << 14);
          data[i] = register & 1 ? 1 : -1;
        }
      }
      if (this.context.state === "suspended")
        void this.context.resume().catch(() => {});
    } catch {
      /* The game remains playable without Web Audio. */
    }
  }

  private output?: AudioNode;

  configure(change: Partial<SoundSettings>) {
    this.settings = { ...this.settings, ...change };
    this.settings.volume = Number.isFinite(this.settings.volume)
      ? Math.max(0, Math.min(1, this.settings.volume))
      : defaultSoundSettings.volume;
    try {
      localStorage.setItem(soundSettingsKey, JSON.stringify(this.settings));
    } catch {
      /* Optional persistence. */
    }
    if (!this.settings.enabled || this.settings.volume === 0) this.stop();
    if (!this.settings.seppuku) this.stop("seppuku");
    if (this.master && this.context) {
      this.master.gain.setTargetAtTime(
        this.settings.enabled ? this.settings.volume ** 2 : 0,
        this.context.currentTime,
        0.015,
      );
    }
  }

  setFocused(focused: boolean) {
    this.focused = focused;
    if (!focused) this.stop();
  }

  private get audible() {
    return (
      this.focused &&
      this.settings.enabled &&
      this.settings.volume > 0 &&
      this.context?.state === "running"
    );
  }

  play(cue: SoundCue, age = 0) {
    if (!this.audible || (cue === "seppuku" && !this.settings.seppuku)) return;
    const now = this.context!.currentTime;
    const gap = cue === "stamina" ? 0.9 : cue === "hurt" ? 0.12 : 0.055;
    if (now - (this.lastPlayed.get(cue) ?? -Infinity) < gap) return;
    this.lastPlayed.set(cue, now);
    if (
      cue === "death" ||
      cue === "seppuku" ||
      cue === "victory" ||
      cue === "defeat" ||
      cue === "draw"
    )
      this.stop();
    // Tiny pitch variations keep repeated combat sounds from feeling identical.
    const variation = ["swing", "shot", "hit", "shield", "hurt"].includes(cue)
      ? 0.96 + Math.random() * 0.08
      : 1;
    for (const [at, duration, frequency, end, level, wave] of score[cue]) {
      if (at + duration <= age) continue;
      const note = this.voice(
        cue,
        wave,
        Math.max(0, at - age),
        duration,
        frequency * variation,
        end * variation,
        level,
      );
      if (!note) break;
    }
  }

  /** One rising voice per draw; it fades at full tension instead of whining forever. */
  setBowDraw(progress: number) {
    if (progress <= 0 || !this.audible) {
      this.stop("bow");
      return;
    }
    if (!this.drawing) {
      this.drawing = true;
      this.bow = this.voice("bow", "triangle", 0, 1.15, 150, 150, 0.045);
    }
    if (this.bow && this.context) {
      const pitch = 150 * 2 ** (Math.round(Math.min(1, progress) * 12) / 12);
      (this.bow.source as OscillatorNode).frequency.setTargetAtTime(
        pitch,
        this.context.currentTime,
        0.018,
      );
    }
  }

  stop(cue?: Voice["cue"]) {
    for (const voice of [...this.voices]) {
      if (cue && voice.cue !== cue) continue;
      const now = this.context!.currentTime;
      if (voice.start > now) voice.source.stop(now);
      else {
        voice.gain.gain.cancelAndHoldAtTime(now);
        voice.gain.gain.setTargetAtTime(0, now, 0.005);
        voice.source.stop(now + 0.025);
      }
      this.voices.delete(voice);
    }
    if (!cue || cue === "bow") {
      this.bow = undefined;
      this.drawing = false;
    }
  }

  private voice(
    cue: Voice["cue"],
    wave: Wave,
    delay: number,
    duration: number,
    frequency: number,
    end: number,
    level: number,
  ): Voice | undefined {
    if (!this.audible || !this.output || this.voices.size >= 24) return;
    const context = this.context!;
    const start = context.currentTime + delay;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(level, start + 0.005);
    if (cue === "bow") gain.gain.setValueAtTime(level * 0.8, start + 0.8);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    gain.connect(this.output);
    let source: AudioScheduledSourceNode;
    let filter: BiquadFilterNode | undefined;
    if (wave === "noise") {
      const buffer = context.createBufferSource();
      buffer.buffer = this.noise!;
      buffer.loop = true;
      filter = context.createBiquadFilter();
      filter.type = "lowpass";
      filter.Q.value = 0.7;
      filter.frequency.setValueAtTime(frequency, start);
      filter.frequency.exponentialRampToValueAtTime(end, start + duration);
      buffer.connect(filter).connect(gain);
      source = buffer;
    } else {
      const oscillator = context.createOscillator();
      oscillator.type = wave;
      oscillator.frequency.setValueAtTime(frequency, start);
      if (frequency !== end)
        oscillator.frequency.exponentialRampToValueAtTime(
          end,
          start + duration,
        );
      oscillator.connect(gain);
      source = oscillator;
    }
    const voice: Voice = { source, gain, filter, cue, start };
    this.voices.add(voice);
    source.onended = () => {
      source.disconnect();
      gain.disconnect();
      filter?.disconnect();
      this.voices.delete(voice);
      if (this.bow === voice) this.bow = undefined;
    };
    source.start(start);
    source.stop(start + duration + 0.01);
    return voice;
  }
}
