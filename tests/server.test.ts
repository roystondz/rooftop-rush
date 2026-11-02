// Starts the real server on a random port and connects to it like browsers would.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MATCH } from '../shared/constants';
import type { ClientMessage, LobbyInfo, ServerMessage } from '../shared/protocol';
import { startServer, type RunningServer } from '../server/server';

let server: RunningServer;

beforeEach(async () => {
  // 0 = any free port. Short timers so quick-match and back-to-lobby tests run fast.
  server = await startServer(0, undefined, { quickStartDelayMs: 300, backToLobbyMs: 300 });
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

  /** The newest lobby message. */
  lobby(): LobbyInfo {
    const all = this.messages.filter((m): m is Extract<ServerMessage, { t: 'lobby' }> => m.t === 'lobby');
    return all[all.length - 1];
  }

  /** Waits until the lobby satisfies a condition. */
  async lobbyWhere(test: (l: LobbyInfo) => boolean): Promise<LobbyInfo> {
    await this.waitFor('lobby', (m) => test(m));
    const deadline = Date.now() + 2000;
    while (!test(this.lobby())) {
      if (Date.now() > deadline) throw new Error('lobby never settled');
      await new Promise((r) => setTimeout(r, 10));
    }
    return this.lobby();
  }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The host creates a private room; the others join with the code. Nobody has started yet. */
async function lobbyWith(count: number, create: Record<string, unknown> = {}): Promise<[TestClient[], string]> {
  const host = await TestClient.connect(server.port);
  host.send({ t: 'create', ...create });
  const code = (await host.waitFor('lobby')).code;
  const clients = [host];
  for (let i = 1; i < count; i++) {
    const c = await TestClient.connect(server.port);
    c.send({ t: 'join', code: code.toLowerCase(), name: `Friend ${i}` });
    await c.waitFor('lobby');
    clients.push(c);
  }
  await host.lobbyWhere((l) => l.players.length === count);
  return [clients, code];
}

/** A private 1v1 that the host has started. */
async function startMatch(): Promise<[TestClient, TestClient, string]> {
  const [[a, b], code] = await lobbyWith(2);
  a.send({ t: 'start' });
  await a.waitFor('start');
  await b.waitFor('start');
  return [a, b, code];
}

const closeAll = (clients: TestClient[]) => clients.forEach((c) => c.close());

describe('lobby', () => {
  it('creates a private room: you are its host, on team 0, and nothing starts by itself', async () => {
    const [[host], code] = await lobbyWith(1);
    const l = host.lobby();
    expect(code).toMatch(/^[A-Z]{4}$/);
    expect(l.isPublic).toBe(false);
    expect(l.host).toBe(l.you);
    expect(l.players).toEqual([{ seat: l.you, name: 'PLAYER 1', team: 0 }]);
    expect(l.started).toBe(false);
    host.close();
  });

  it('puts people who join on the emptier team, and tells everyone', async () => {
    const [clients] = await lobbyWith(4);
    const l = clients[0].lobby();
    expect(l.players.filter((p) => p.team === 0)).toHaveLength(2);
    expect(l.players.filter((p) => p.team === 1)).toHaveLength(2);
    expect(clients[3].lobby().you).toBe(3);
    closeAll(clients);
  });

  it('names each team after its first person', async () => {
    const [clients] = await lobbyWith(2, { name: 'Royal Strikers' });
    expect(clients[1].lobby().names).toEqual(['ROYAL STRIKERS', 'FRIEND 1']);
    closeAll(clients);
  });

  it('lets people change teams, but never more than 3 a side', async () => {
    const [clients] = await lobbyWith(4); // 2 v 2
    clients[1].send({ t: 'team', team: 0 }); // seat 1 is on team 1: move to team 0 → 3 v 1
    const after = await clients[0].lobbyWhere((l) => l.players.find((p) => p.seat === 1)?.team === 0);
    expect(after.players.filter((p) => p.team === 0)).toHaveLength(3);
    clients[3].send({ t: 'team', team: 0 }); // team 0 is full now
    await pause(150);
    expect(clients[0].lobby().players.find((p) => p.seat === 3)?.team).toBe(1);
    closeAll(clients);
  });

  it('only the host can start, and only with someone on each team', async () => {
    const [[host, friend]] = await lobbyWith(2);
    friend.send({ t: 'start' }); // not the host
    await pause(150);
    expect(host.messages.some((m) => m.t === 'start')).toBe(false);
    friend.send({ t: 'team', team: 0 }); // everyone on one team
    await host.lobbyWhere((l) => l.players.every((p) => p.team === 0));
    host.send({ t: 'start' });
    await pause(150);
    expect(host.messages.some((m) => m.t === 'start')).toBe(false);
    friend.send({ t: 'team', team: 1 });
    await host.lobbyWhere((l) => l.players.some((p) => p.team === 1));
    host.send({ t: 'start' });
    expect((await friend.waitFor('start')).team).toBe(1);
    closeAll([host, friend]);
  });

  it('passes host to the next person if the host leaves', async () => {
    const [[host, a, b]] = await lobbyWith(3);
    host.close();
    const l = await a.lobbyWhere((x) => x.players.length === 2);
    expect(l.host).toBe(1);
    closeAll([a, b]);
  });

  it('says so when a room code does not exist or the room is full', async () => {
    const [clients, code] = await lobbyWith(6);
    const c = await TestClient.connect(server.port);
    c.send({ t: 'join', code: 'ZZZZ' });
    expect((await c.waitFor('error')).message).toContain('ZZZZ');
    c.send({ t: 'join', code });
    expect((await c.waitFor('error', (m) => m.message.includes('full'))).message).toContain('full');
    closeAll([...clients, c]);
  });
});

describe('3v3 matches', () => {
  it('gives six people six different players, three a side', async () => {
    const [clients] = await lobbyWith(6);
    clients[0].send({ t: 'start' });
    const starts = await Promise.all(clients.map((c) => c.waitFor('start')));
    expect(starts.filter((s) => s.team === 0)).toHaveLength(3);
    const snap = (await clients[0].waitFor('snap')).s;
    const players = starts.map((s) => snap.controlled[s.you]);
    expect(new Set(players).size).toBe(6);
    expect(players.every((p) => p >= 0)).toBe(true);
    closeAll(clients);
  });

  it("moves each person's own player from their own inputs only", async () => {
    const [clients] = await lobbyWith(4);
    clients[0].send({ t: 'start' });
    const starts = await Promise.all(clients.map((c) => c.waitFor('start')));
    await pause(MATCH.kickoffDelay * 1000 + 100);
    // Seat 2 is on team 0 (midfielder) — not the kicker, so free to move.
    const mover = clients[2];
    const me = starts[2].you;
    const before = mover.latestSnap().s;
    const myPlayer = before.controlled[me];
    for (let seq = 1; seq <= 30; seq++) {
      mover.send({ t: 'input', seq, i: [0, 1, 0] });
      await pause(1000 / 60);
    }
    await pause(100);
    const after = mover.latestSnap().s;
    const z = (s: typeof before, id: number) => s.p[id * 8 + 1];
    expect(z(after, myPlayer)).toBeGreaterThan(z(before, myPlayer) + 1);
    // Seat 0's player (the kicker, waiting to pass) didn't move.
    const kicker = before.controlled[starts[0].you];
    expect(z(after, kicker)).toBe(z(before, kicker));
    closeAll(clients);
  });

  it('lets someone join a match already under way, taking over a bot', async () => {
    const [a, b, code] = await startMatch();
    const c = await TestClient.connect(server.port);
    c.send({ t: 'join', code, name: 'Late Larry' });
    const start = await c.waitFor('start');
    const snap = await c.waitFor('snap', (m) => m.s.controlled[start.you] >= 0);
    const players = [a, b, c].map((x) => snap.s.controlled[x.lobby().you]);
    expect(new Set(players).size).toBe(3);
    expect((await a.waitFor('notice')).text).toContain('LATE LARRY');
    closeAll([a, b, c]);
  });

  it('keeps the match going with a bot when someone leaves, and removes the empty room', async () => {
    const [[a, b, c], code] = await lobbyWith(3);
    a.send({ t: 'start' });
    await c.waitFor('start');
    const before = (await a.waitFor('snap')).s.tick;
    b.close();
    expect((await a.waitFor('notice')).text).toContain('bot took over');
    await pause(200);
    expect(a.latestSnap().s.tick).toBeGreaterThan(before); // still playing
    a.close();
    c.close();
    await pause(100);
    expect(server.rooms.has(code)).toBe(false);
  });

  it('goes back to the lobby together after full time', async () => {
    const [a, b, code] = await startMatch();
    const room = server.rooms.get(code)!;
    room.world!.time = 0.05;
    room.world!.score = [1, 0];
    room.world!.phase = 'playing';
    await a.waitFor('snap', (m) => m.s.phase === 'fulltime');
    const lobby = await b.lobbyWhere((l) => !l.started);
    expect(lobby.players).toHaveLength(2);
    a.send({ t: 'start' }); // and the host can start again
    await b.waitFor('start', () => b.messages.filter((m) => m.t === 'start').length >= 2);
    closeAll([a, b]);
  });
});

describe('quick match', () => {
  it('fills an open lobby and starts by itself once both teams have someone', async () => {
    const a = await TestClient.connect(server.port);
    const b = await TestClient.connect(server.port);
    a.send({ t: 'quick' });
    const roomA = await a.waitFor('lobby');
    b.send({ t: 'quick' });
    const roomB = await b.waitFor('lobby');
    expect(roomB.code).toBe(roomA.code);
    expect((await a.lobbyWhere((l) => l.startsIn !== null)).startsIn).not.toBeNull();
    await a.waitFor('start', undefined, 3000);
    closeAll([a, b]);
  });

  it('only pairs players who picked the same mode', async () => {
    const a = await TestClient.connect(server.port);
    const b = await TestClient.connect(server.port);
    a.send({ t: 'quick', mode: 'penalties' });
    const roomA = await a.waitFor('lobby');
    b.send({ t: 'quick', mode: 'match' });
    const roomB = await b.waitFor('lobby');
    expect(roomB.code).not.toBe(roomA.code);
    closeAll([a, b]);
  });
});

describe('online play', () => {
  it('dresses each team in its first person\'s kit, and never both teams the same', async () => {
    const host = await TestClient.connect(server.port);
    host.send({ t: 'create', kit: 2 });
    const code = (await host.waitFor('lobby')).code;
    const friend = await TestClient.connect(server.port);
    friend.send({ t: 'join', code, kit: 2 }); // same kit as the host: their team changes
    await host.lobbyWhere((l) => l.players.length === 2);
    expect(host.lobby().kits).toEqual([2, 1]);
    host.send({ t: 'start' });
    expect((await friend.waitFor('start')).kits).toEqual([2, 1]);
    closeAll([host, friend]);
  });

  it('ignores a kit that does not exist', async () => {
    const [clients] = await lobbyWith(2, { kit: 99 });
    expect(clients[0].lobby().kits).toEqual([0, 1]);
    closeAll(clients);
  });

  it("tells everyone the team names, cleaned up", async () => {
    const [[a, b]] = await lobbyWith(1, { name: '  red lions ' }).then(async ([[host], code]) => {
      const friend = await TestClient.connect(server.port);
      friend.send({ t: 'join', code, name: '<i>Tigers</i> 🐯' });
      await host.lobbyWhere((l) => l.players.length === 2);
      return [[host, friend], code] as [TestClient[], string];
    });
    a.send({ t: 'start' });
    expect((await a.waitFor('start')).names).toEqual(['RED LIONS', 'ITIGERSI']);
    expect((await b.waitFor('start')).names).toEqual(['RED LIONS', 'ITIGERSI']);
    closeAll([a, b]);
  });

  it('plays a penalty shootout online: both get the mode, and kicks are scored', async () => {
    const [[a, b]] = await lobbyWith(2, { mode: 'penalties' });
    expect(a.lobby().mode).toBe('penalties');
    a.send({ t: 'start' });
    expect((await a.waitFor('start')).mode).toBe('penalties');
    await a.waitFor('snap', (m) => m.s.phase === 'playing' && m.s.mode === 'penalties');
    let seq = 0;
    const send = async (i: [number, number, number], ticks: number) => {
      for (let k = 0; k < ticks; k++) {
        a.send({ t: 'input', seq: ++seq, i });
        await pause(1000 / 60);
      }
    };
    await send([0.9, 0.43, 0], 20);
    await send([0, 0, 2], 25); // shoot held
    await send([0, 0, 0], 5);
    const result = await b.waitFor('snap', (m) => m.s.shootout !== null && m.s.shootout.kicks[0].length === 1, 6000);
    expect(result.s.shootout!.kicks[0]).toHaveLength(1);
    closeAll([a, b]);
  });

  it('sends everyone the same snapshots, about 60 per second', async () => {
    const [a, b] = await startMatch();
    await pause(1000);
    const snapsA = a.messages.filter((m) => m.t === 'snap').length;
    expect(snapsA).toBeGreaterThan(45);
    expect(snapsA).toBeLessThan(75);
    const tick = a.latestSnap().s.tick;
    const same = await b.waitFor('snap', (m) => m.s.tick === tick);
    expect(same.s.p).toEqual(a.latestSnap().s.p);
    closeAll([a, b]);
  });

  it('catches up after a burst of inputs instead of falling behind for good', async () => {
    const [a, b] = await startMatch();
    await a.waitFor('snap');
    for (let seq = 1; seq <= 20; seq++) a.send({ t: 'input', seq, i: [0, 0, 0] });
    await pause(150);
    expect(a.latestSnap().ack).toBe(20);
    closeAll([a, b]);
  });

  it('ignores junk messages without disconnecting the client', async () => {
    const [a, b] = await startMatch();
    a.sendRaw('not json at all');
    a.send({ t: 'input', seq: 1, i: [999, 999, 255] });
    a.send({ t: 'teleport', x: 20 });
    a.send({ t: 'team', team: 7 });
    a.send({ t: 'ping', at: 42 });
    expect((await a.waitFor('pong')).at).toBe(42);
    closeAll([a, b]);
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
