// One match between two people. The server owns the World: clients only send inputs,
// and everyone receives the same snapshots. That's what stops cheating.
import { Bot, BOT_SKILLS } from '../shared/bot';
import { DT } from '../shared/constants';
import { autoSwitch, switchToNearest, type Controlled } from '../shared/control';
import { makeSnapshot, SNAPSHOT_EVERY, unpackInput, type ClientMessage, type ServerMessage } from '../shared/protocol';
import { createWorld, step } from '../shared/sim';
import { NO_INPUT } from '../shared/types';
import type { Input, MatchEvent, Team, World } from '../shared/types';

/** Inputs waiting to be used. A few are kept so short network hiccups don't drop button presses. */
const MAX_QUEUED_INPUTS = 8;
/**
 * Inputs arrive at 60/s and are used at 60/s, so a backlog from a burst would never drain and
 * would add lasting delay. Beyond this many waiting, the server skips ahead (keeping button taps).
 */
const MAX_INPUT_BACKLOG = 2;
/** If the server falls behind (e.g. the machine was busy), catch up at most this many ticks at once. */
const MAX_CATCH_UP = 10;

export interface Seat {
  team: Team;
  send: (m: ServerMessage) => void;
  queue: { seq: number; input: Input }[];
  last: Input;
  lastSeq: number; // highest input number received
  ack: number; // input number last used by the simulation
  wantsRematch: boolean;
}

export class Room {
  readonly seats: [Seat | null, Seat | null] = [null, null];
  world: World | null = null;
  private bots: Bot[] = [];
  private controlled: Controlled = [-1, -1];
  private events: MatchEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly code: string,
    readonly isPublic: boolean,
    private readonly onEmpty: (room: Room) => void,
  ) {}

  get playerCount(): number {
    return this.seats.filter(Boolean).length;
  }

  get started(): boolean {
    return this.world !== null;
  }

  /** Seats a new client. Returns null when the room is full. */
  join(send: (m: ServerMessage) => void): Seat | null {
    const team: Team | -1 = this.seats[0] === null ? 0 : this.seats[1] === null ? 1 : -1;
    if (team === -1) return null;
    const seat: Seat = { team, send, queue: [], last: { ...NO_INPUT }, lastSeq: -1, ack: -1, wantsRematch: false };
    this.seats[team] = seat;
    send({ t: 'room', code: this.code, team, isPublic: this.isPublic });
    if (this.playerCount === 2) this.start();
    return seat;
  }

  leave(seat: Seat): void {
    if (this.seats[seat.team] !== seat) return;
    this.seats[seat.team] = null;
    this.stopLoop();
    this.world = null;
    for (const other of this.seats) other?.send({ t: 'left' });
    if (this.playerCount === 0) this.onEmpty(this);
  }

  handle(seat: Seat, msg: ClientMessage): void {
    switch (msg.t) {
      case 'input':
        if (msg.seq <= seat.lastSeq) return; // old or repeated packet
        seat.lastSeq = msg.seq;
        seat.queue.push({ seq: msg.seq, input: unpackInput(msg.i) });
        if (seat.queue.length > MAX_QUEUED_INPUTS) seat.queue.shift();
        break;
      case 'switch':
        if (this.world?.phase === 'playing') {
          const change = switchToNearest(this.world, this.controlled, seat.team);
          if (change) this.handOver([change]);
        }
        break;
      case 'rematch':
        if (this.world?.phase !== 'fulltime') return;
        seat.wantsRematch = true;
        for (const s of this.seats) s?.send({ t: 'rematch', team: seat.team });
        if (this.seats.every((s) => s?.wantsRematch)) this.start();
        break;
      case 'leave':
        this.leave(seat);
        break;
      default:
        break;
    }
  }

  private start(): void {
    const w = createWorld();
    this.world = w;
    this.bots = w.players.map((p) => new Bot(p.id, BOT_SKILLS.normal, Date.now() % 100000));
    this.controlled = [0, 1].map((team) => w.players.find((p) => p.team === team && p.role === 'attacker')!.id);
    this.events = [];
    for (const s of this.seats) {
      if (!s) continue;
      Object.assign(s, { queue: [], last: { ...NO_INPUT }, wantsRematch: false });
      s.send({ t: 'start', team: s.team });
    }
    this.startLoop();
  }

  /** Runs exactly 60 ticks per second, correcting for timer drift. */
  private startLoop(): void {
    this.stopLoop();
    const startedAt = performance.now();
    let ticks = 0;
    const run = () => {
      const due = Math.floor((performance.now() - startedAt) / (DT * 1000));
      let steps = 0;
      while (ticks < due && this.world) {
        if (steps++ >= MAX_CATCH_UP) {
          ticks = due; // too far behind: skip ahead rather than fast-forward
          break;
        }
        this.tick(this.world);
        ticks++;
      }
      if (this.world && this.world.phase !== 'fulltime') this.timer = setTimeout(run, 4);
    };
    this.timer = setTimeout(run, 0);
  }

  private stopLoop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private tick(w: World): void {
    const humanInput: Input[] = [];
    for (const seat of this.seats) {
      if (!seat) continue;
      let next = seat.queue.shift();
      while (next && seat.queue.length > MAX_INPUT_BACKLOG) {
        const skipped = next.input;
        next = seat.queue.shift()!;
        next.input = {
          ...next.input,
          pass: next.input.pass || skipped.pass,
          tackle: next.input.tackle || skipped.tackle,
        };
      }
      if (next) {
        seat.last = next.input;
        seat.ack = next.seq;
        humanInput[seat.team] = next.input;
      } else {
        // Nothing arrived in time: keep moving the same way, but don't repeat button taps.
        humanInput[seat.team] = { ...seat.last, pass: false, tackle: false };
      }
    }

    const humans = new Set(this.controlled.filter((id) => id >= 0));
    const inputs = w.players.map((p) =>
      p.id === this.controlled[p.team] ? humanInput[p.team] : this.bots[p.id].think(w, humans),
    );
    step(w, inputs);
    this.events.push(...w.events);
    this.handOver(autoSwitch(this.controlled, w.events));

    if (w.tick % SNAPSHOT_EVERY === 0 || w.phase === 'fulltime') this.broadcast(w);
  }

  private handOver(changes: { from: number; to: number }[]): void {
    for (const c of changes) {
      this.bots[c.from]?.reset();
      this.bots[c.to]?.reset();
    }
  }

  private broadcast(w: World): void {
    const s = makeSnapshot(w, this.controlled, this.events);
    this.events = [];
    for (const seat of this.seats) seat?.send({ t: 'snap', s, ack: seat.ack });
  }
}
