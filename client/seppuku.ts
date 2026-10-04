import { ease, seppukuDuration, seppukuImpact } from "./render/seppuku.ts";
import "./seppuku.css";

export class SeppukuPresentation {
  private audio?: AudioContext;
  private sounds: AudioScheduledSourceNode[] = [];
  private lastTick = -1;
  private motion = matchMedia("(prefers-reduced-motion: reduce)");
  private overlay = document.getElementById("seppuku-cinematic")!;
  private hud = document.getElementById("hud")!;

  get reducedMotion() {
    return this.motion.matches;
  }

  // Called directly from the confirmation click to unlock browser audio.
  unlockAudio() {
    try {
      this.audio ??= new AudioContext();
      void this.audio.resume().catch(() => {});
    } catch {
      /* The visual ceremony works without audio. */
    }
  }

  update(startTick: number | undefined, age: number, sound: boolean) {
    const visible =
      startTick !== undefined && age >= 0 && age < seppukuDuration;
    this.overlay.hidden = !visible;
    this.hud.inert = visible;
    document.body.classList.toggle("seppuku-playing", visible);
    if (!visible) return;
    if (this.lastTick !== startTick) {
      this.lastTick = startTick;
      if (sound && age < 0.5) this.playSound(age);
    }
    const impact = Math.max(0, 1 - Math.abs(age - seppukuImpact - 0.06) / 0.12);
    this.overlay.style.setProperty("--ceremony-in", String(ease(0, 0.65, age)));
    this.overlay.style.setProperty(
      "--ceremony-out",
      String(1 - ease(4.6, seppukuDuration, age)),
    );
    this.overlay.style.setProperty(
      "--ceremony-flash",
      String(this.reducedMotion ? 0 : impact * 0.7),
    );
    this.overlay.style.setProperty(
      "--ceremony-title",
      String(ease(2.8, 3.6, age)),
    );
    this.overlay.style.setProperty(
      "--ceremony-line",
      String(ease(seppukuImpact, seppukuImpact + 0.23, age)),
    );
    this.overlay.style.setProperty(
      "--ceremony-line-fade",
      String(1 - ease(2.5, 2.95, age)),
    );
    this.overlay.dataset.stage = age < seppukuImpact ? "ritual" : "defeat";
  }

  reset() {
    this.lastTick = -1;
    this.overlay.hidden = true;
    this.hud.inert = false;
    document.body.classList.remove("seppuku-playing");
    for (const source of this.sounds) {
      try {
        source.stop();
      } catch {
        /* Already ended. */
      }
    }
    this.sounds = [];
  }

  private playSound(age: number) {
    const context = this.audio;
    if (!context || context.state !== "running") return;
    const start = context.currentTime - age;
    const tone = (
      at: number,
      frequency: number,
      end: number,
      duration: number,
      volume: number,
      type: OscillatorType = "sine",
    ) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const when = Math.max(context.currentTime, start + at);
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(frequency, when);
      oscillator.frequency.exponentialRampToValueAtTime(end, when + duration);
      gain.gain.setValueAtTime(0, when);
      gain.gain.linearRampToValueAtTime(volume, when + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, when + duration);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(when);
      oscillator.stop(when + duration);
      oscillator.onended = () => {
        oscillator.disconnect();
        gain.disconnect();
      };
      this.sounds.push(oscillator);
    };
    tone(0.12, 90, 34, 0.4, 0.16);
    tone(0.85, 80, 32, 0.4, 0.18);
    tone(1.5, 440, 1200, 0.5, 0.018, "triangle");
    tone(seppukuImpact, 135, 25, 0.9, 0.28);
    tone(seppukuImpact, 1300, 180, 0.22, 0.055, "triangle");
    tone(2.3, 110, 55, 1.8, 0.075);
  }
}
