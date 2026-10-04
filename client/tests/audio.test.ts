import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { ArenaAudio, type SoundCue } from "../audio.ts";

class Parameter {
  value = 0;
  setValueAtTime(value: number) {
    this.value = value;
  }
  linearRampToValueAtTime(value: number) {
    this.value = value;
  }
  exponentialRampToValueAtTime(value: number) {
    this.value = value;
  }
  setTargetAtTime(value: number) {
    this.value = value;
  }
  cancelAndHoldAtTime() {}
}
class Node {
  disconnected = false;
  connect<T>(node: T): T {
    return node;
  }
  disconnect() {
    this.disconnected = true;
  }
}
class Source extends Node {
  frequency = new Parameter();
  onended?: () => void;
  startTime = -1;
  stops: number[] = [];
  start(time: number) {
    this.startTime = time;
  }
  stop(time: number) {
    this.stops.push(time);
  }
}
class Context {
  static instances: Context[] = [];
  currentTime = 0;
  state = "suspended";
  sampleRate = 8000;
  destination = new Node();
  sources: Source[] = [];
  gains: (Node & { gain: Parameter })[] = [];
  filters: (Node & { frequency: Parameter; Q: Parameter })[] = [];
  constructor() {
    Context.instances.push(this);
  }
  resume() {
    this.state = "running";
    return Promise.resolve();
  }
  createGain() {
    const node = Object.assign(new Node(), { gain: new Parameter() });
    this.gains.push(node);
    return node;
  }
  createDynamicsCompressor() {
    return Object.assign(new Node(), {
      threshold: new Parameter(),
      knee: new Parameter(),
      ratio: new Parameter(),
      attack: new Parameter(),
      release: new Parameter(),
    });
  }
  createBuffer() {
    return { getChannelData: () => new Float32Array(this.sampleRate) };
  }
  createOscillator() {
    const source = new Source();
    this.sources.push(source);
    return source;
  }
  createBufferSource() {
    return this.createOscillator();
  }
  createBiquadFilter() {
    const node = Object.assign(new Node(), {
      frequency: new Parameter(),
      Q: new Parameter(),
    });
    this.filters.push(node);
    return node;
  }
}
function setup(t: TestContext) {
  const storageDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "AudioContext",
  );
  Object.defineProperty(globalThis, "AudioContext", {
    configurable: true,
    value: Context,
  });
  Context.instances = [];
  t.after(() => {
    if (storageDescriptor)
      Object.defineProperty(globalThis, "localStorage", storageDescriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
    if (descriptor)
      Object.defineProperty(globalThis, "AudioContext", descriptor);
    else Reflect.deleteProperty(globalThis, "AudioContext");
  });
  return new ArenaAudio();
}

test("audio waits for a gesture, never queues locked sounds, and reuses one context", (t) => {
  const audio = setup(t);
  audio.play("hit");
  audio.setBowDraw(0.2);
  assert.equal(Context.instances.length, 0);
  audio.unlock();
  audio.unlock();
  assert.equal(Context.instances.length, 1);
  const context = Context.instances[0];
  assert.equal(context.sources.length, 0);
  audio.play("hit");
  assert.equal(context.sources.length, 2);
  for (const source of context.sources) source.onended?.();
  assert.ok(context.sources.every((source) => source.disconnected));
  assert.ok(context.filters.every((filter) => filter.disconnected));
  assert.ok(context.gains.slice(1).every((gain) => gain.disconnected));
});

test("mute cancels even future melody notes and blocks new effects including seppuku", (t) => {
  const audio = setup(t);
  audio.unlock();
  const context = Context.instances[0];
  audio.play("seppuku");
  assert.ok(context.sources.some((source) => source.startTime > 2));
  const count = context.sources.length;
  audio.configure({ enabled: false });
  assert.ok(context.sources.every((source) => source.stops.at(-1) === 0));
  assert.equal(context.gains[0].gain.value, 0);
  audio.play("hit");
  audio.play("seppuku");
  audio.setBowDraw(0.5);
  assert.equal(context.sources.length, count);
  audio.configure({ enabled: true, volume: 0 });
  audio.play("shot");
  assert.equal(context.sources.length, count);
  audio.configure({ volume: 0.5, seppuku: false });
  audio.play("seppuku");
  assert.equal(context.sources.length, count);
  audio.play("shot");
  assert.equal(context.sources.length, count + 2);
  assert.equal(context.gains[0].gain.value, 0.25);
});

test("bow uses one voice, rises with draw, stops on cancellation and stays quiet after full draw", (t) => {
  const audio = setup(t);
  audio.unlock();
  const context = Context.instances[0];
  audio.setBowDraw(0.1);
  const initialPitch = context.sources[0].frequency.value;
  for (let i = 2; i <= 60; i++) audio.setBowDraw(i / 60);
  assert.equal(context.sources.length, 1);
  assert.ok(context.sources[0].frequency.value > initialPitch);
  context.sources[0].onended?.();
  audio.setBowDraw(1);
  assert.equal(context.sources.length, 1);
  audio.setBowDraw(0);
  audio.setBowDraw(0.1);
  assert.equal(context.sources.length, 2);
  audio.setBowDraw(0);
  assert.equal(context.sources[1].stops.at(-1), 0.025);
});

test("focus loss stops sounds, consumes no queued audio and allows fresh effects on return", (t) => {
  const audio = setup(t);
  audio.unlock();
  const context = Context.instances[0];
  audio.play("victory");
  const count = context.sources.length;
  audio.setFocused(false);
  assert.ok(
    context.sources.every(
      (source) => source.stops.at(-1) === (source.startTime > 0 ? 0 : 0.025),
    ),
  );
  audio.play("death");
  audio.setFocused(true);
  assert.equal(context.sources.length, count);
  audio.play("shot");
  assert.equal(context.sources.length, count + 2);
});

test("rapid effects are throttled, voices are bounded, and capacity is reclaimed after ending", (t) => {
  const audio = setup(t);
  audio.unlock();
  const context = Context.instances[0];
  for (let i = 0; i < 100; i++) audio.play("stamina");
  assert.equal(context.sources.length, 2);
  for (let i = 0; i < 100; i++) {
    context.currentTime += 0.1;
    audio.play("hit");
  }
  assert.equal(context.sources.length, 24);
  for (const source of context.sources) source.onended?.();
  context.currentTime += 1;
  audio.play("hit");
  assert.equal(context.sources.length, 26);
});

test("every cue schedules finite bounded notes and stops cleanly", (t) => {
  const audio = setup(t);
  audio.unlock();
  const context = Context.instances[0];
  const cues: SoundCue[] = [
    "swing",
    "shot",
    "hit",
    "shield",
    "hurt",
    "stamina",
    "kill",
    "death",
    "countdown",
    "start",
    "victory",
    "defeat",
    "draw",
    "seppuku",
  ];
  for (const cue of cues) {
    const count = context.sources.length;
    audio.play(cue);
    const sources = context.sources.slice(count);
    assert.ok(sources.length > 0, cue);
    assert.ok(
      sources.every(
        (source) =>
          Number.isFinite(source.stops[0]) &&
          source.stops[0] > source.startTime &&
          source.stops[0] < context.currentTime + 5,
      ),
      cue,
    );
    audio.stop();
    for (const source of sources) source.onended?.();
    context.currentTime += 5;
  }
});

test("an unavailable AudioContext never prevents playing the game", (t) => {
  const audio = setup(t);
  Object.defineProperty(globalThis, "AudioContext", {
    configurable: true,
    value: class {
      constructor() {
        throw new Error("Unavailable");
      }
    },
  });
  assert.doesNotThrow(() => {
    audio.unlock();
    audio.play("hit");
    audio.setBowDraw(0.5);
    audio.stop();
  });
});
