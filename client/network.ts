import {
  protocolVersion,
  world,
  type DummyAction,
  type Input,
  type ServerMessage,
  type Snapshot,
  type Welcome,
} from "./protocol.ts";

export interface Transport {
  send(input: Input): boolean;
  close(): void;
}

export interface NetworkEvents {
  welcome(message: Welcome): void;
  snapshot(message: Snapshot): void;
  status(message: string, online: boolean): void;
  failed(message: string): void;
  ping(milliseconds: number): void;
  dummyResult(message: string): void;
  seppukuResult(accepted: boolean, message: string): void;
}

export class MatchConnection implements Transport {
  private socket: WebSocket | null = null;
  private token = "";
  private stopped = false;
  private retry = 0;
  private heartbeat?: ReturnType<typeof setInterval>;
  private reconnect?: ReturnType<typeof setTimeout>;
  private lastMessage = 0;
  private ready = false;

  constructor(
    private room: string,
    private name: string,
    private events: NetworkEvents,
  ) {
    this.open();
  }

  private open() {
    if (this.stopped) return;
    this.events.status(
      this.retry ? "Возвращаемся в матч…" : "Подключаемся…",
      false,
    );
    const url = new URL(
      `${import.meta.env.BASE_URL}ws/${this.room}`,
      location.href,
    );
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = (this.socket = new WebSocket(url));
    this.lastMessage = performance.now();
    socket.onopen = () =>
      socket.send(
        JSON.stringify({
          type: "hello",
          version: protocolVersion,
          mapVersion: world.version,
          name: this.name,
          token: this.token,
        }),
      );
    socket.onmessage = (event) => {
      if (socket !== this.socket || this.stopped) return;
      this.lastMessage = performance.now();
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data);
      } catch {
        this.close();
        this.events.failed("Не удалось прочитать ответ сервера.");
        return;
      }
      if (message.type === "welcome") {
        if (message.mapVersion !== world.version) {
          this.close();
          this.events.failed("Карта обновилась. Перезагрузите страницу.");
          return;
        }
        this.token = message.token;
        this.retry = 0;
        this.ready = true;
        this.events.welcome(message);
        this.events.status("На связи", true);
      } else if (message.type === "snapshot") this.events.snapshot(message);
      else if (message.type === "dummy_result")
        this.events.dummyResult(message.message);
      else if (message.type === "seppuku_result")
        this.events.seppukuResult(message.accepted, message.message);
      else if (message.type === "probe")
        socket.send(
          JSON.stringify({ type: "probe_ack", probe: message.probe }),
        );
      else if (message.type === "pong")
        this.events.ping(Math.round(performance.now() - message.time));
    };
    this.heartbeat = setInterval(() => {
      if (performance.now() - this.lastMessage > 4000) {
        socket.close();
        return;
      }
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: "ping", time: performance.now() }));
    }, 1000);
    socket.onclose = (event) => {
      if (socket !== this.socket) return;
      clearInterval(this.heartbeat);
      this.ready = false;
      if (this.stopped) return;
      this.events.status("Связь прервалась…", false);
      if (event.code === 1008 || !this.token || this.retry >= 8) {
        this.stopped = true;
        this.events.failed(
          event.reason ||
            "Комната недоступна. Проверьте код и подключение к серверу.",
        );
        return;
      }
      this.retry++;
      this.reconnect = setTimeout(
        () => this.open(),
        Math.min(300 * this.retry, 1800),
      );
    };
  }

  send(input: Input): boolean {
    return this.sendMessage({ type: "input", input });
  }

  manageDummies(action: DummyAction): boolean {
    return this.sendMessage({ type: action });
  }

  seppuku(life: number): boolean {
    return this.sendMessage({ type: "seppuku", life });
  }

  private sendMessage(message: {
    type: string;
    input?: Input;
    life?: number;
  }): boolean {
    if (
      !this.ready ||
      !this.socket ||
      this.socket.readyState !== WebSocket.OPEN ||
      this.socket.bufferedAmount > 16_384
    )
      return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  close() {
    this.stopped = true;
    this.ready = false;
    clearTimeout(this.reconnect);
    clearInterval(this.heartbeat);
    this.socket?.close(1000, "Игрок вышел");
  }
}

export async function createRoom(): Promise<string> {
  const response = await fetch(`${import.meta.env.BASE_URL}api/rooms`, {
    method: "POST",
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()).room;
}
