import type { Input } from "./protocol.ts";
import { clamp, wrapAngle } from "./simulation.ts";

export class Controls {
  yaw = 0;
  pitch = 0;
  enabled = false;
  private keys = new Set<string>();
  private attack = false;
  private block = false;
  private jump = false;
  private drag = false;
  private swing = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private onMenu: () => void,
  ) {
    window.addEventListener("keydown", (e) => {
      if (!this.enabled) return;
      if (
        [
          "Space",
          "ArrowLeft",
          "ArrowRight",
          "ArrowUp",
          "ArrowDown",
          "Tab",
        ].includes(e.code)
      )
        e.preventDefault();
      if (e.code === "Escape" || e.code === "KeyP") {
        this.onMenu();
        return;
      }
      this.keys.add(e.code);
      if (!e.repeat && e.code === "Space") this.jump = true;
      if (!e.repeat && e.code === "KeyF") {
        this.attack = true;
        this.swing = true;
      }
      if (e.code === "KeyB") this.block = true;
    });
    window.addEventListener("keyup", (e) => {
      this.keys.delete(e.code);
      if (e.code === "KeyF") this.attack = false;
      if (e.code === "KeyB") this.block = false;
    });
    canvas.addEventListener("mousedown", (e) => {
      if (!this.enabled) return;
      this.drag = true;
      if (e.button === 0) {
        this.attack = true;
        this.swing = true;
      }
      if (e.button === 2) this.block = true;
      if (!document.pointerLockElement) void this.capture();
    });
    window.addEventListener("mouseup", (e) => {
      this.drag = false;
      if (e.button === 0) this.attack = false;
      if (e.button === 2) this.block = false;
    });
    window.addEventListener("mousemove", (e) => {
      if (!this.enabled || (!document.pointerLockElement && !this.drag)) return;
      this.yaw = wrapAngle(this.yaw - e.movementX * 0.0022);
      this.pitch = clamp(this.pitch - e.movementY * 0.0022, -1.35, 1.35);
    });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("blur", () => this.clear());
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.clear();
    });
    document.addEventListener("pointerlockchange", () => {
      if (!document.pointerLockElement) this.clear();
    });
  }

  async capture() {
    try {
      await this.canvas.requestPointerLock();
    } catch {
      /* Drag and arrow keys remain available. */
    }
  }
  clear() {
    this.keys.clear();
    this.attack = false;
    this.block = false;
    this.jump = false;
    this.drag = false;
    this.swing = false;
  }
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled) this.clear();
  }

  sample(seq: number): Input {
    if (this.enabled) {
      this.yaw = wrapAngle(
        this.yaw +
          (((this.keys.has("ArrowLeft") ? 1 : 0) -
            (this.keys.has("ArrowRight") ? 1 : 0)) *
            1.7) /
            60,
      );
      this.pitch = clamp(
        this.pitch +
          ((this.keys.has("ArrowUp") ? 1 : 0) -
            (this.keys.has("ArrowDown") ? 1 : 0)) /
            60,
        -1.35,
        1.35,
      );
    }
    const input: Input = {
      seq,
      yaw: this.yaw,
      pitch: this.pitch,
      forward: this.enabled
        ? Number(this.keys.has("KeyW")) - Number(this.keys.has("KeyS"))
        : 0,
      strafe: this.enabled
        ? Number(this.keys.has("KeyD")) - Number(this.keys.has("KeyA"))
        : 0,
      jump: this.enabled && this.jump,
      sprint:
        this.enabled &&
        (this.keys.has("ShiftLeft") || this.keys.has("ShiftRight")),
      attack: this.enabled && (this.attack || this.swing),
      block: this.enabled && this.block,
    };
    this.jump = false;
    this.swing = false;
    return input;
  }
}
