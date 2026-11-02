// One online room: a lobby where up to six people pick teams, then the match itself.
// The server owns the World: people only send inputs, and everyone receives the same snapshots.
// That's what stops cheating. Any spot without a person is played by a bot, so 1v1, 2v3 or 3v3
// all work, people can join a match already under way, and a bot takes over if someone leaves.
import { Bot, BOT_SKILLS } from '../shared/bot';
import { DT } from '../shared/constants';
import {
  assignStartingPlayers,
  autoSwitch,
  autoSwitchDefending,
  humanPlayers,
  switchToNearest,
  SwitchTimer,
  type Handover,
  type Human,
} from '../shared/control';
import { CHAT_COOLDOWN_MS } from '../shared/chat';
import { cleanKit, DEFAULT_KITS, teamKits } from '../shared/kits';
import { cleanTeamName, DEFAULT_TEAM_NAMES, teamNames } from '../shared/names';
import {
  makeSnapshot,
  MAX_PER_TEAM,
  MAX_PLAYERS,
  SNAPSHOT_EVERY,
  unpackInput,
  type ClientMessage,
  type ServerMessage,
} from '../shared/protocol';
import { createWorld, step } from '../shared/sim';
import { NO_INPUT } from '../shared/types';
import type { GameMode, Input, MatchEvent, Team, World } from '../shared/types';

/** Inputs waiting to be used. A few are kept so short network hiccups don't drop button presses. */
const MAX_QUEUED_INPUTS = 8;
/**
 * Inputs arrive at 60/s and are used at 60/s, so a backlog from a burst would never drain and
 * would add lasting delay. Beyond this many waiting, the server skips ahead (keeping button taps).
 */
const MAX_INPUT_BACKLOG = 2;
/** If the server falls behind (e.g. the machine was busy), catch up at most this many ticks at once. */
const MAX_CATCH_UP = 10;

export interface RoomOptions {
  /** Quick match: how long to wait for more people once both teams have someone. */
  quickStartDelayMs?: number;
  /** After full time, how long the results stay up before everyone is back in the lobby. */
  backToLobbyMs?: number;
}

export interface Seat {
  seat: number;
  team: Team;
  /** The name this person typed (cleaned). The first person on a team names the team. */
  name: string;
  /** The kit this person picked, if any. The first person on a team chooses the team's kit. */
  kit?: number;
  send: (m: ServerMessage) => void;
  queue: { seq: number; input: Input }[];
  last: Input;
  lastSeq: number; // highest input number received
  ack: number; // input number last used by the simulation
  lastChat: number; // when this person last sent a quick-chat message (ms)
}

export class Room {
  readonly seats: (Seat | null)[] = Array.from({ length: MAX_PLAYERS }, () => null);
  world: World | null = null;
  /** Seat of the person who can start the match (-1 when the room is empty). */
  host = -1;

  private bots: Bot[] = [];
  private humans: Human[] = [];
  private names: [string, string] = [...DEFAULT_TEAM_NAMES];
  private kits: [number, number] = [...DEFAULT_KITS];
  private events: MatchEvent[] = [];
  private loop: ReturnType<typeof setTimeout> | null = null;
  private quickStart: { timer: ReturnType<typeof setTimeout>; at: number } | null = null;
  private lobbyReturn: ReturnType<typeof setTimeout> | null = null;
  private switchTimer = new SwitchTimer();
  private readonly quickStartDelayMs: number;
  private readonly backToLobbyMs: number;

  constructor(
    readonly code: string,
    readonly isPublic: boolean,
    private readonly onEmpty: (room: Room) => void,
    readonly mode: GameMode = 'match',
    options: RoomOptions = {},
  ) {
    this.quickStartDelayMs = options.quickStartDelayMs ?? 6000;
    this.backToLobbyMs = options.backToLobbyMs ?? 6000;
  }

  get playerCount(): number {
    return this.seats.filter(Boolean).length;
  }

  get started(): boolean {
    return this.world !== null;
  }

  get full(): boolean {
    return this.playerCount >= MAX_PLAYERS;
  }

  teamCount(team: Team): number {
    return this.seats.filter((s) => s?.team === team).length;
  }

  /** Seats a new person on the emptier team. Returns null when the room is full. */
  join(send: (m: ServerMessage) => void, wantedName?: string, wantedKit?: number): Seat | null {
    const index = this.seats.indexOf(null);
    if (index < 0) return null;
    const team: Team = this.teamCount(1) < this.teamCount(0) ? 1 : 0;
    const seat: Seat = {
      seat: index,
      team: this.teamCount(team) < MAX_PER_TEAM ? team : team === 0 ? 1 : 0,
      name: cleanTeamName(wantedName, `PLAYER ${index + 1}`),
      kit: wantedKit === undefined ? undefined : cleanKit(wantedKit, DEFAULT_KITS[0]),
      send,
      queue: [],
      last: { ...NO_INPUT },
      lastSeq: -1,
      ack: -1,
      lastChat: 0,
    };
    this.seats[index] = seat;
    if (this.host < 0) this.host = index;

    if (this.world) {
      // Joining a match already under way: take over one of your team's bots.
      const human: Human = { seat: index, team: seat.team, player: this.freePlayer(seat.team) };
      this.humans.push(human);
      this.bots[human.player]?.reset();
      send({ t: 'start', you: index, team: seat.team, names: this.names, kits: this.kits, mode: this.mode });
      this.notice(`${seat.name} joined the match`, seat);
    }
    this.broadcastLobby();
    this.considerQuickStart();
    return seat;
  }

  leave(seat: Seat): void {
    if (this.seats[seat.seat] !== seat) return;
    this.seats[seat.seat] = null;
    if (this.host === seat.seat) this.host = this.seats.findIndex(Boolean);

    if (this.playerCount === 0) {
      this.stopLoop();
      this.cancelTimers();
      this.world = null;
      this.onEmpty(this);
      return;
    }
    if (this.world) {
      // A bot takes over their player and the match carries on.
      const human = this.humans.find((h) => h.seat === seat.seat);
      this.humans = this.humans.filter((h) => h !== human);
      if (human) this.bots[human.player]?.reset();
      this.notice(`${seat.name} left — a bot took over`);
    }
    this.broadcastLobby();
    this.considerQuickStart();
  }

  handle(seat: Seat, msg: ClientMessage): void {
    switch (msg.t) {
      case 'input':
        if (msg.seq <= seat.lastSeq) return; // old or repeated packet
        seat.lastSeq = msg.seq;
        seat.queue.push({ seq: msg.seq, input: unpackInput(msg.i) });
        if (seat.queue.length > MAX_QUEUED_INPUTS) seat.queue.shift();
        break;
      case 'switch': {
        const me = this.humans.find((h) => h.seat === seat.seat);
        if (this.world?.phase === 'playing' && me) {
          this.handOver([switchToNearest(this.world, this.humans, me, this.switchTimer)]);
        }
        break;
      }
      case 'team':
        // Change teams in the lobby, if there's room on the other side.
        if (this.world || seat.team === msg.team || this.teamCount(msg.team) >= MAX_PER_TEAM) return;
        seat.team = msg.team;
        this.broadcastLobby();
        this.considerQuickStart();
        break;
      case 'start':
        if (!this.world && seat.seat === this.host && this.canStart()) this.start();
        break;
      case 'chat': {
        // Quick chat goes to everyone in the room, at most once a second per person.
        const now = Date.now();
        if (now - seat.lastChat < CHAT_COOLDOWN_MS) return;
        seat.lastChat = now;
        for (const s of this.seats) s?.send({ t: 'chat', seat: seat.seat, team: seat.team, name: seat.name, id: msg.id });
        break;
      }
      case 'leave':
        this.leave(seat);
        break;
      default:
        break;
    }
  }

  /** A match needs at least one person on each team. */
  canStart(): boolean {
    return this.teamCount(0) > 0 && this.teamCount(1) > 0;
  }

  // --- lobby ---------------------------------------------------------------------

  private broadcastLobby(): void {
    const players = this.seats
      .filter((s): s is Seat => s !== null)
      .map((s) => ({ seat: s.seat, name: s.name, team: s.team }));
    const startsIn = this.quickStart ? Math.max(0, Math.ceil((this.quickStart.at - Date.now()) / 1000)) : null;
    const names = this.world ? this.names : this.lobbyNames();
    const kits = this.world ? this.kits : this.lobbyKits();
    for (const s of this.seats) {
      s?.send({
        t: 'lobby',
        code: this.code,
        mode: this.mode,
        isPublic: this.isPublic,
        host: this.host,
        you: s.seat,
        started: this.started,
        startsIn,
        players,
        names,
        kits,
      });
    }
  }

  /** Each team is named by its first person (lowest seat). */
  private lobbyNames(): [string, string] {
    const captain = (team: Team) =>
      this.seats.filter((s): s is Seat => s?.team === team).sort((a, b) => a.seat - b.seat)[0]?.name;
    return teamNames(captain(0), captain(1));
  }

  /** Each team wears its first person's kit; on a clash the second team changes. */
  private lobbyKits(): [number, number] {
    const captain = (team: Team) =>
      this.seats.filter((s): s is Seat => s?.team === team).sort((a, b) => a.seat - b.seat)[0]?.kit;
    return teamKits(captain(0), captain(1));
  }

  /**
   * Quick match starts by itself: straight away when the room is full, otherwise a few seconds
   * after both teams have someone (giving others a chance to join).
   */
  private considerQuickStart(): void {
    if (!this.isPublic || this.world) return;
    if (!this.canStart()) {
      this.cancelTimers();
      return;
    }
    if (this.full) {
      this.start();
      return;
    }
    if (this.quickStart) return;
    const at = Date.now() + this.quickStartDelayMs;
    const timer = setTimeout(() => {
      this.quickStart = null;
      if (!this.world && this.canStart()) this.start();
    }, this.quickStartDelayMs);
    this.quickStart = { timer, at };
    this.broadcastLobby();
  }

  private cancelTimers(): void {
    if (this.quickStart) clearTimeout(this.quickStart.timer);
    this.quickStart = null;
    if (this.lobbyReturn) clearTimeout(this.lobbyReturn);
    this.lobbyReturn = null;
  }

  private notice(text: string, except?: Seat): void {
    for (const s of this.seats) if (s && s !== except) s.send({ t: 'notice', text });
  }

  // --- match ---------------------------------------------------------------------

  private start(): void {
    this.cancelTimers();
    const w = createWorld({ mode: this.mode });
    this.world = w;
    // A fresh random seed each match, so bots don't repeat the same choices game after game.
    const seed = Math.floor(Math.random() * 1e9);
    this.bots = w.players.map((p) => new Bot(p.id, BOT_SKILLS.normal, seed));
    this.names = this.lobbyNames();
    this.kits = this.lobbyKits();
    this.humans = this.seats
      .filter((s): s is Seat => s !== null)
      .map((s) => ({ seat: s.seat, team: s.team, player: -1 }));
    assignStartingPlayers(w, this.humans);
    this.events = [];
    this.switchTimer = new SwitchTimer();
    for (const s of this.seats) {
      if (!s) continue;
      Object.assign(s, { queue: [], last: { ...NO_INPUT } });
      s.send({ t: 'start', you: s.seat, team: s.team, names: this.names, kits: this.kits, mode: this.mode });
    }
    this.broadcastLobby();
    this.startLoop();
  }

  /** A player on `team` that no person controls (outfield first). */
  private freePlayer(team: Team): number {
    const taken = humanPlayers(this.humans);
    const free = this.world!.players.filter((p) => p.team === team && !taken.has(p.id));
    return (free.find((p) => p.role !== 'keeper') ?? free[0])?.id ?? -1;
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
      if (this.world && this.world.phase !== 'fulltime') this.loop = setTimeout(run, 4);
    };
    this.loop = setTimeout(run, 0);
  }

  private stopLoop(): void {
    if (this.loop) clearTimeout(this.loop);
    this.loop = null;
  }

  private tick(w: World): void {
    const inputBySeat = new Map<number, Input>();
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
          through: next.input.through || skipped.through,
          skill: next.input.skill || skipped.skill,
          // A skipped pass or shot keeps its lob, so it isn't played along the ground instead.
          lob: next.input.lob || (skipped.lob && (skipped.pass || !!skipped.through || skipped.shoot)),
        };
      }
      if (next) {
        seat.last = next.input;
        seat.ack = next.seq;
        inputBySeat.set(seat.seat, next.input);
      } else {
        // Nothing arrived in time: keep moving the same way, but don't repeat button taps.
        inputBySeat.set(seat.seat, { ...seat.last, pass: false, tackle: false, through: false, skill: false });
      }
    }

    const taken = humanPlayers(this.humans);
    const inputs = w.players.map((p) => {
      const human = this.humans.find((h) => h.player === p.id);
      return human ? (inputBySeat.get(human.seat) ?? NO_INPUT) : this.bots[p.id].think(w, taken);
    });
    step(w, inputs);
    this.events.push(...w.events);
    this.handOver(autoSwitch(w, this.humans, w.events, this.switchTimer));
    for (const h of this.humans) this.handOver([autoSwitchDefending(w, this.humans, h, this.switchTimer)]);

    if (w.tick % SNAPSHOT_EVERY === 0 || w.phase === 'fulltime') this.broadcast(w);
    if (w.phase === 'fulltime') this.scheduleLobbyReturn();
  }

  /** After full time, everyone goes back to the lobby together (same room, same teams). */
  private scheduleLobbyReturn(): void {
    if (this.lobbyReturn) return;
    this.lobbyReturn = setTimeout(() => {
      this.lobbyReturn = null;
      this.world = null;
      this.humans = [];
      this.broadcastLobby();
      this.considerQuickStart();
    }, this.backToLobbyMs);
  }

  private handOver(changes: (Handover | null)[]): void {
    for (const c of changes) {
      if (!c) continue;
      if (c.from >= 0) this.bots[c.from]?.reset();
      if (c.to >= 0) this.bots[c.to]?.reset();
    }
  }

  private broadcast(w: World): void {
    const bySeat = this.seats.map((s) => (s ? (this.humans.find((h) => h.seat === s.seat)?.player ?? -1) : -1));
    const s = makeSnapshot(w, bySeat, this.events);
    this.events = [];
    for (const seat of this.seats) seat?.send({ t: 'snap', s, ack: seat.ack });
  }
}
