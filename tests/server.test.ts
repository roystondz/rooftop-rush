// Starts the real server on a random port and connects to it like two browsers would.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MATCH } from '../shared/constants';
import type { ClientMessage, ServerMessage } from '../shared/protocol';
import { startServer, type RunningServer } from '../server/server';

let server: RunningServer;

beforeEach(async () => {
  server = await startServer(0); // 0 = any free port
});

afterEach(async () => {
  await server.close();
});

/** A test client that records every message it receives. */
class TestClient {
  messages: ServerMessage[] = [];
  private ws!: WebSocket;

  static async connect(port: number): Promise<TestClient> {
    const c = new TestClient();
    c.ws = new WebSocket(`ws://localhost:${port}`);
    c.ws.addEventListener('message', (e) => c.messages.push(JSON.parse(String(e.data))));
    await new Promise((resolve, reject) => {
      c.ws.addEventListener('open', resolve);
      c.ws.addEventListener('error', reject);
    });
    return c;
  }

  send(m: ClientMessage | Record<string, unknown>): void {
    this.ws.send(JSON.stringify(m));
  }

  sendRaw(text: string): void {
    this.ws.send(text);
  }

  close(): void {
    this.ws.close();
  }

  async waitFor<T extends ServerMessage['t']>(
    type: T,
    match: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true,
    timeoutMs = 4000,
  ): Promise<Extract<ServerMessage, { t: T }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.find((m) => m.t === type && match(m as Extract<ServerMessage, { t: T }>));
      if (found) return found as Extract<ServerMessage, { t: T }>;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${type}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  latestSnap() {
    const snaps = this.messages.filter((m): m is Extract<ServerMessage, { t: 'snap' }> => m.t === 'snap');
    return snaps[snaps.length - 1];
  }
}

async function startMatch(): Promise<[TestClient, TestClient, string]> {
  const a = await TestClient.connect(server.port);
  a.send({ t: 'create' });
  const room = await a.waitFor('room');
  const b = await TestClient.connect(server.port);
  b.send({ t: 'join', code: room.code.toLowerCase() });
  await a.waitFor('start');
  await b.waitFor('start');
  return [a, b, room.code];
}

describe('game server', () => {
  it('creates a private room and lets a friend join with the code', async () => {
    const a = await TestClient.connect(server.port);
    a.send({ t: 'create' });
    const room = await a.waitFor('room');
    expect(room.code).toMatch(/^[A-Z]{4}$/);
    expect(room.team).toBe(0);
    expect(room.isPublic).toBe(false);

    const b = await TestClient.connect(server.port);
    b.send({ t: 'join', code: room.code });
    expect((await b.waitFor('room')).team).toBe(1);
    expect((await a.waitFor('start')).team).toBe(0);
    expect((await b.waitFor('start')).team).toBe(1);
    a.close();
    b.close();
  });

  it("tells both players each other's team names, cleaned up", async () => {
    const a = await TestClient.connect(server.port);
    a.send({ t: 'create', name: '  red lions ' });
    const room = await a.waitFor('room');
    const b = await TestClient.connect(server.port);
    b.send({ t: 'join', code: room.code, name: '<i>Tigers</i> 🐯' });
    const startA = await a.waitFor('start');
    const startB = await b.waitFor('start');
    expect(startA.names).toEqual(['RED LIONS', 'ITIGERSI']);
    expect(startB.names).toEqual(startA.names);
    a.close();
    b.close();
  });

  it('uses the default names when nobody picks one', async () => {
    const [a, b] = await startMatch();
    expect((await a.waitFor('start')).names).toEqual(['SKYLINE', 'NEON']);
    a.close();
    b.close();
  });

  it('pairs two quick-match players together', async () => {
    const a = await TestClient.connect(server.port);
    const b = await TestClient.connect(server.port);
    a.send({ t: 'quick' });
    const roomA = await a.waitFor('room');
    b.send({ t: 'quick' });
    const roomB = await b.waitFor('room');
    expect(roomB.code).toBe(roomA.code);
    await a.waitFor('start');
    a.close();
    b.close();
  });

  it('says so when a room code does not exist or the room is full', async () => {
    const [a, b, code] = await startMatch();
    const c = await TestClient.connect(server.port);
    c.send({ t: 'join', code: 'ZZZZ' });
    expect((await c.waitFor('error')).message).toContain('ZZZZ');
    c.send({ t: 'join', code });
    expect((await c.waitFor('error', (m) => m.message.includes('full'))).message).toContain('full');
    [a, b, c].forEach((x) => x.close());
  });

  it('sends both players the same snapshots, about 30 per second', async () => {
    const [a, b] = await startMatch();
    await new Promise((r) => setTimeout(r, 1000));
    const snapsA = a.messages.filter((m) => m.t === 'snap').length;
    expect(snapsA).toBeGreaterThan(20);
    expect(snapsA).toBeLessThan(40);
    const tick = a.latestSnap().s.tick;
    const same = await b.waitFor('snap', (m) => m.s.tick === tick);
    expect(same.s.p).toEqual(a.latestSnap().s.p);
    a.close();
    b.close();
  });

  it("moves a player only from that player's own inputs", async () => {
    const [a, b] = await startMatch();
    const first = await b.waitFor('snap');
    // Team 0 kicks off first, so move team 1's player (the kicker must stand still until they pass).
    const theirId = first.s.controlled[1];
    const myId = first.s.controlled[0];
    await new Promise((r) => setTimeout(r, MATCH.kickoffDelay * 1000 + 100));
    const before = b.latestSnap().s;
    for (let seq = 1; seq <= 30; seq++) {
      b.send({ t: 'input', seq, i: [0, -1, 0] });
      await new Promise((r) => setTimeout(r, 1000 / 60));
    }
    await new Promise((r) => setTimeout(r, 100));
    const after = b.latestSnap();
    const z = (s: typeof before, id: number) => s.p[id * 8 + 1];
    expect(z(after.s, theirId)).toBeLessThan(z(before, theirId) - 1);
    expect(after.ack).toBeGreaterThan(20); // the server confirms which inputs it used
    expect(z(a.latestSnap().s, myId)).toBe(z(before, myId)); // the other player's didn't move
    a.close();
    b.close();
  });

  it('catches up after a burst of inputs instead of falling behind for good', async () => {
    const [a, b] = await startMatch();
    await a.waitFor('snap');
    // 20 inputs arrive at once, as after a network stall.
    for (let seq = 1; seq <= 20; seq++) a.send({ t: 'input', seq, i: [0, 0, 0] });
    // Used one per tick, that backlog would take 20 ticks; skipping ahead clears it in a few.
    await new Promise((r) => setTimeout(r, 150));
    expect(a.latestSnap().ack).toBe(20);
    a.close();
    b.close();
  });

  it('ignores junk messages without disconnecting the client', async () => {
    const [a, b] = await startMatch();
    a.sendRaw('not json at all');
    a.send({ t: 'input', seq: 1, i: [999, 999, 255] });
    a.send({ t: 'teleport', x: 20 });
    a.send({ t: 'ping', at: 42 });
    expect((await a.waitFor('pong')).at).toBe(42);
    a.close();
    b.close();
  });

  it('tells the other player when someone leaves, and removes the empty room', async () => {
    const [a, b, code] = await startMatch();
    a.close();
    await b.waitFor('left');
    b.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(server.rooms.has(code)).toBe(false);
  });

  it('only allows a rematch after full time, then restarts when both agree', async () => {
    const [a, b, code] = await startMatch();
    a.send({ t: 'rematch' });
    await new Promise((r) => setTimeout(r, 100));
    expect(b.messages.some((m) => m.t === 'rematch')).toBe(false);

    // Fast-forward this match to full time.
    const room = server.rooms.get(code)!;
    room.world!.time = 0.05;
    room.world!.score = [1, 0];
    room.world!.phase = 'playing';
    await a.waitFor('snap', (m) => m.s.phase === 'fulltime');

    const startsBefore = a.messages.filter((m) => m.t === 'start').length;
    a.send({ t: 'rematch' });
    await b.waitFor('rematch');
    b.send({ t: 'rematch' });
    await new Promise((r) => setTimeout(r, 150));
    expect(a.messages.filter((m) => m.t === 'start').length).toBe(startsBefore + 1);
    a.close();
    b.close();
  });
});

describe('serving the built game', () => {
  it('serves files from the folder, and nothing outside it', async () => {
    const { mkdtemp, writeFile, mkdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const dir = await mkdtemp(path.join(tmpdir(), 'rr-static-'));
    await writeFile(path.join(dir, 'index.html'), '<h1>game</h1>');
    await mkdir(path.join(dir, 'assets'));
    await writeFile(path.join(dir, 'assets', 'app-123.js'), 'console.log(1)');
    const s = await startServer(0, dir);
    const base = `http://localhost:${s.port}`;
    try {
      const page = await fetch(base + '/');
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toContain('text/html');
      expect(await page.text()).toBe('<h1>game</h1>');

      const js = await fetch(base + '/assets/app-123.js');
      expect(js.headers.get('content-type')).toContain('javascript');
      expect(js.headers.get('cache-control')).toContain('immutable');

      expect((await fetch(base + '/health')).status).toBe(200);
      expect((await fetch(base + '/missing.js')).status).toBe(404);
      for (const sneaky of ['/../package.json', '/%2e%2e/package.json', '/assets/..%2F..%2Fpackage.json']) {
        expect([403, 404]).toContain((await fetch(base + sneaky)).status);
      }
      expect((await fetch(base + '/', { method: 'POST' })).status).toBe(405);
    } finally {
      await s.close();
    }
  });
});
