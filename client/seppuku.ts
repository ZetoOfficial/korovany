import { ease, seppukuDuration, seppukuImpact } from "./render/seppuku.ts";
import "./seppuku.css";
import type { ArenaAudio } from "./audio.ts";

export class SeppukuPresentation {
  private lastTick = -1;
  private motion = matchMedia("(prefers-reduced-motion: reduce)");
  private overlay = document.getElementById("seppuku-cinematic")!;
  private hud = document.getElementById("hud")!;

  constructor(private audio: ArenaAudio) {}

  get reducedMotion() {
    return this.motion.matches;
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
      if (sound && age < 0.5) this.audio.play("seppuku", age);
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
    this.audio.stop("seppuku");
  }
}
