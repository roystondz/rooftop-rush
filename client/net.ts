import { DEFAULT_PORT, type ClientMessage, type ServerMessage } from '../shared/protocol';

/**
 * Where the game server lives.
 * - Development (`npm run dev`): the page is on port 5173 and the server on 2567 of the same machine.
 * - Built and deployed: the game server serves the page itself, so it's the same address.
 * - Page hosted somewhere else (e.g. GitHub Pages): set VITE_SERVER_URL when building.
 */
export function serverUrl(): string {
  const configured = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (configured) return configured;
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  if (import.meta.env.PROD) return `${scheme}://${location.host}`;
  return `${scheme}://${location.hostname}:${DEFAULT_PORT}`;
}

/**
 * Fake bad internet for testing, e.g. ?lag=200&jitter=40 adds 200 ms round trip, with each
 * message up to 40 ms later still. Half the lag is added on the way out, half on the way back.
 */
export interface LagSettings {
  lagMs: number;
  jitterMs: number;
}

export function lagFromUrl(search = location.search): LagSettings {
  const q = new URLSearchParams(search);
  const num = (k: string) => Math.max(0, Math.min(2000, Number(q.get(k)) || 0));
  return { lagMs: num('lag'), jitterMs: num('jitter') };
}

/** Delays callbacks like a network would, while keeping their order (as TCP does). */
class DelayLine {
  private lastAt = 0;
  constructor(private settings: LagSettings) {}

  run(fn: () => void): void {
    const { lagMs, jitterMs } = this.settings;
    if (lagMs === 0 && jitterMs === 0) {
      fn();
      return;
    }
    const at = Math.max(performance.now() + lagMs / 2 + Math.random() * jitterMs, this.lastAt);
    this.lastAt = at;
    setTimeout(fn, at - performance.now());
  }
}

/** A thin wrapper around a browser WebSocket that speaks our message types. */
export class Connection {
  onMessage: (m: ServerMessage) => void = () => {};
  onClose: () => void = () => {};
  private outgoing: DelayLine;
  private incoming: DelayLine;

  private constructor(
    private ws: WebSocket,
    readonly lag: LagSettings,
  ) {
    this.outgoing = new DelayLine(lag);
    this.incoming = new DelayLine(lag);
    ws.addEventListener('message', (e) => {
      this.incoming.run(() => {
        try {
          this.onMessage(JSON.parse(String(e.data)) as ServerMessage);
        } catch {
          // ignore anything that isn't valid JSON
        }
      });
    });
    ws.addEventListener('close', () => this.onClose());
  }

  static open(url = serverUrl(), lag: LagSettings = { lagMs: 0, jitterMs: 0 }, timeoutMs = 5000): Promise<Connection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('timeout'));
      }, timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(new Connection(ws, lag));
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('could not connect'));
      });
    });
  }

  get isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  send(m: ClientMessage): void {
    const text = JSON.stringify(m);
    this.outgoing.run(() => {
      if (this.isOpen) this.ws.send(text);
    });
  }

  close(): void {
    this.ws.close();
  }
}
