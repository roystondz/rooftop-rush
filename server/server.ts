// The WebSocket server: matchmaking, room codes, and passing messages to rooms.
import http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { parseClientMessage, type ServerMessage } from '../shared/protocol';
import type { GameMode } from '../shared/types';
import { Room, type RoomOptions, type Seat } from './room';
import { staticFiles } from './static';

/** Letters that are hard to mix up when read aloud or typed (no I, L, O, 0, 1). */
const CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ';
/** Messages per second a client may send before extras are ignored (inputs are 60/s). */
const MAX_MESSAGES_PER_SECOND = 120;

export interface RunningServer {
  port: number;
  rooms: Map<string, Room>;
  close(): Promise<void>;
}

/** `staticDir`: serve the built game from this folder too (used when deployed). */
export function startServer(port: number, staticDir?: string, roomOptions: RoomOptions = {}): Promise<RunningServer> {
  const rooms = new Map<string, Room>();
  const serveFile = staticDir ? staticFiles(staticDir) : null;

  const httpServer = http.createServer((req, res) => {
    // A small status reply so hosting services (and you) can check the server is alive.
    if (req.url === '/health' || (req.url === '/' && !serveFile)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
      return;
    }
    if (serveFile) void serveFile(req, res);
    else res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ server: httpServer, maxPayload: 1024 });

  const newCode = (): string => {
    for (;;) {
      let code = '';
      for (let i = 0; i < 4; i++) code += CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)];
      if (!rooms.has(code)) return code;
    }
  };

  const createRoom = (isPublic: boolean, mode: GameMode = 'match'): Room => {
    const room = new Room(newCode(), isPublic, (r) => rooms.delete(r.code), mode, roomOptions);
    rooms.set(room.code, room);
    return room;
  };

  wss.on('connection', (ws: WebSocket) => {
    let room: Room | null = null;
    let seat: Seat | null = null;
    let windowStart = Date.now();
    let count = 0;

    const send = (m: ServerMessage) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
    };

    const enter = (r: Room, name?: string, kit?: number) => {
      const s = r.join(send, name, kit);
      if (!s) {
        send({ t: 'error', message: 'That room is full.' });
        return;
      }
      room = r;
      seat = s;
    };

    ws.on('message', (data) => {
      const now = Date.now();
      if (now - windowStart > 1000) {
        windowStart = now;
        count = 0;
      }
      if (++count > MAX_MESSAGES_PER_SECOND) return;

      const msg = parseClientMessage(data.toString());
      if (!msg) return;

      switch (msg.t) {
        case 'ping':
          send({ t: 'pong', at: msg.at });
          return;
        case 'quick': {
          if (room) return;
          // Quick match: the fullest public lobby for the same kind of game, then a match already
          // under way that has space, and only then a new room.
          const mode = msg.mode ?? 'match';
          const open = [...rooms.values()].filter((r) => r.isPublic && r.mode === mode && !r.full);
          const byFullest = (a: Room, b: Room) => b.playerCount - a.playerCount;
          const lobby = open.filter((r) => !r.started).sort(byFullest)[0];
          const live = open.filter((r) => r.started).sort(byFullest)[0];
          enter(lobby ?? live ?? createRoom(true, mode), msg.name, msg.kit);
          return;
        }
        case 'create':
          if (!room) enter(createRoom(false, msg.mode), msg.name, msg.kit);
          return;
        case 'join': {
          if (room) return;
          const r = rooms.get(msg.code);
          if (!r) send({ t: 'error', message: `No room with code ${msg.code}.` });
          else enter(r, msg.name, msg.kit);
          return;
        }
        case 'leave':
          if (room && seat) room.leave(seat);
          room = null;
          seat = null;
          return;
        default:
          if (room && seat) room.handle(seat, msg);
      }
    });

    ws.on('close', () => {
      if (room && seat) room.leave(seat);
    });
  });

  return new Promise((resolve) => {
    httpServer.listen(port, () => {
      const address = httpServer.address();
      resolve({
        port: typeof address === 'object' && address ? address.port : port,
        rooms,
        close: () =>
          new Promise<void>((done) => {
            for (const client of wss.clients) client.terminate();
            wss.close(() => httpServer.close(() => done()));
          }),
      });
    });
  });
}
