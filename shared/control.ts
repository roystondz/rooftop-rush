// Which player each human controls. Used by the local game and by the server, so both behave the same.
//
// Every person in a match has a seat (0-5) on a team and controls one player at a time. With
// several people on the same team, nobody's player is ever taken over by a teammate: automatic
// switching only moves you onto players that bots are running.
import { penaltyDuel } from './sim';
import type { MatchEvent, Role, Team, World } from './types';

/** One person in the match and the player they are controlling right now. */
export interface Human {
  seat: number;
  team: Team;
  player: number;
}

/** A player a human just stopped or started controlling; its bot brain should forget what it was doing. */
export type Handover = { from: number; to: number };

/** Ticks after any switch before an automatic defensive switch may happen (stops flickering). */
const AUTO_SWITCH_COOLDOWN = 45;
/** Switch automatically only when you are at least this far from the ball… */
const AUTO_SWITCH_MIN_DISTANCE = 5;
/** …and a teammate is at least this much closer. */
const AUTO_SWITCH_ADVANTAGE = 3;
/** The order people on one team are given players at a kickoff. */
const ROLE_ORDER: readonly Role[] = ['attacker', 'midfielder', 'keeper'];

/** Remembers when each person last switched, so automatic switching can't undo a manual one at once. */
export class SwitchTimer {
  private last = new Map<number, number>();

  mark(w: World, seat: number): void {
    this.last.set(seat, w.tick);
  }

  ready(w: World, seat: number): boolean {
    return w.tick - (this.last.get(seat) ?? -Infinity) >= AUTO_SWITCH_COOLDOWN;
  }
}

/** Ids of every player a person is controlling. Bots leave these alone. */
export function humanPlayers(humans: readonly Human[]): Set<number> {
  return new Set(humans.map((h) => h.player).filter((id) => id >= 0));
}

const isTaken = (humans: readonly Human[], player: number, except?: Human) =>
  humans.some((h) => h !== except && h.player === player);

/** People on a team, in seat order (the first one is the team's captain). */
const onTeam = (humans: readonly Human[], team: Team) =>
  humans.filter((h) => h.team === team).sort((a, b) => a.seat - b.seat);

/**
 * Gives everyone their player for a kickoff or penalty: at a kickoff the first person on a team
 * takes the attacker, the second the midfielder, the third the keeper. In penalties, people on a
 * team take turns to shoot, and turns to go in goal.
 */
export function assignStartingPlayers(w: World, humans: Human[]): Handover[] {
  const changes: Handover[] = [];
  const give = (h: Human, player: number) => {
    if (h.player !== player) changes.push({ from: h.player, to: player });
    h.player = player;
  };
  const byRole = (team: Team, role: Role) => w.players.find((p) => p.team === team && p.role === role)!.id;
  const duel = penaltyDuel(w);
  for (const team of [0, 1] as const) {
    const people = onTeam(humans, team);
    if (people.length === 0) continue;
    if (duel && w.shootout) {
      const kicksSoFar = w.shootout.kicks[w.shootout.taker].length;
      const turn = kicksSoFar % people.length;
      const star = team === duel.taker.team ? duel.taker.id : duel.keeper.id;
      const rest = w.players.filter((p) => p.team === team && p.id !== star).map((p) => p.id);
      people.forEach((h, i) => give(h, i === turn ? star : rest[(i - (i > turn ? 1 : 0)) % rest.length]));
    } else {
      people.forEach((h, i) => give(h, byRole(team, ROLE_ORDER[i % ROLE_ORDER.length])));
    }
  }
  return changes.filter((c) => c.from >= 0 || c.to >= 0);
}

/**
 * Follows the ball automatically: when you pass to a bot, you take over the receiver; when a bot
 * on your team wins the ball, the nearest person on the team takes it over; at each kickoff or
 * penalty everyone gets their starting player.
 */
export function autoSwitch(
  w: World,
  humans: Human[],
  events: readonly MatchEvent[],
  timer?: SwitchTimer,
): Handover[] {
  const changes: Handover[] = [];
  const move = (h: Human, next: number) => {
    if (next === h.player || isTaken(humans, next, h)) return;
    changes.push({ from: h.player, to: next });
    h.player = next;
    timer?.mark(w, h.seat); // so the defending switch can't immediately undo this one
  };
  for (const e of events) {
    if (e.type === 'kickoff' || e.type === 'penaltySetup') {
      changes.push(...assignStartingPlayers(w, humans));
      continue;
    }
    if (e.team === undefined || e.player === undefined) continue;
    if (e.type === 'pass' && e.target !== undefined && e.target >= 0) {
      const passer = humans.find((h) => h.player === e.player);
      if (passer) move(passer, e.target);
    }
    if (e.type === 'possession' && !isTaken(humans, e.player)) {
      // A bot won the ball: hand it to the nearest person on that team.
      const carrier = w.players[e.player];
      const people = onTeam(humans, e.team);
      let nearest: Human | undefined;
      let best = Infinity;
      for (const h of people) {
        const p = w.players[h.player];
        const d = p ? Math.hypot(p.x - carrier.x, p.z - carrier.z) : Infinity;
        if (d < best) {
          best = d;
          nearest = h;
        }
      }
      if (nearest) move(nearest, e.player);
    }
  }
  return changes;
}

/** The teammate the switch button would pick: the outfield player nearest the ball that a bot is running. */
export function switchTarget(w: World, humans: readonly Human[], me: Human): number {
  let best = -1;
  let bestD = Infinity;
  for (const p of w.players) {
    if (p.team !== me.team || p.role === 'keeper' || p.id === me.player || isTaken(humans, p.id, me)) continue;
    const d = Math.hypot(p.x - w.ball.x, p.z - w.ball.z);
    if (d < bestD) {
      best = p.id;
      bestD = d;
    }
  }
  return best;
}

/** Switch button: take over the free teammate nearest the ball (not while you have it). */
export function switchToNearest(w: World, humans: readonly Human[], me: Human, timer?: SwitchTimer): Handover | null {
  if (me.player < 0 || w.ball.owner === me.player || w.mode === 'penalties') return null;
  const best = switchTarget(w, humans, me);
  if (best < 0) return null;
  const change = { from: me.player, to: best };
  me.player = best;
  timer?.mark(w, me.seat);
  return change;
}

/**
 * Defending: when the other team has the ball (or it's loose) and a free teammate is much closer
 * to it than you, take over that teammate so you can get the tackle in.
 */
export function autoSwitchDefending(w: World, humans: readonly Human[], me: Human, timer: SwitchTimer): Handover | null {
  if (me.player < 0 || w.phase !== 'playing' || w.kickoffPending || w.mode === 'penalties') return null;
  const b = w.ball;
  if (b.owner >= 0 && w.players[b.owner].team === me.team) return null; // we have it
  // Our own pass or shot is still travelling: that's not defending.
  if (b.owner < 0 && b.lastTouch >= 0 && w.players[b.lastTouch].team === me.team) return null;
  if (!timer.ready(w, me.seat)) return null;

  const mine = w.players[me.player];
  const myDistance = Math.hypot(mine.x - b.x, mine.z - b.z);
  if (myDistance < AUTO_SWITCH_MIN_DISTANCE) return null;
  const best = switchTarget(w, humans, me);
  if (best < 0) return null;
  const p = w.players[best];
  if (Math.hypot(p.x - b.x, p.z - b.z) > myDistance - AUTO_SWITCH_ADVANTAGE) return null;

  const change = { from: me.player, to: best };
  me.player = best;
  timer.mark(w, me.seat);
  return change;
}

/**
 * "Press" (hold): run at the ball, aiming a little ahead of where it's going, so you can close
 * down the player on it without steering. Returns the move to use while it's held.
 */
export function pressToward(me: { x: number; z: number }, ball: { x: number; z: number; vx: number; vz: number }) {
  const tx = ball.x + ball.vx * 0.25;
  const tz = ball.z + ball.vz * 0.25;
  const dx = tx - me.x;
  const dz = tz - me.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.3) return { moveX: 0, moveZ: 0, sprint: false };
  return { moveX: dx / d, moveZ: dz / d, sprint: d > 3 };
}

/**
 * During penalties the camera sits behind the taker, looking along the pitch toward the goal:
 * +1 when it looks toward +x, -1 toward -x. Null when the normal side-on camera is in use.
 */
export function penaltyCameraForward(w: World): 1 | -1 | null {
  if (w.mode !== 'penalties' || !w.shootout) return null;
  return w.shootout.taker === 0 ? 1 : -1;
}

/**
 * Turns "up/down/left/right on the screen" into a direction on the pitch for the penalty camera,
 * so pushing right always moves (or aims) right as you see it. Other views pass input through.
 */
export function screenToPitch(input: { moveX: number; moveZ: number }, w: World): { moveX: number; moveZ: number } {
  const f = penaltyCameraForward(w);
  if (f === null) return { moveX: input.moveX, moveZ: input.moveZ };
  // Screen up = toward the goal (along x); screen right = the camera's right-hand side (along z).
  return { moveX: -input.moveZ * f, moveZ: input.moveX * f };
}

/** Rebuilds the list of people from a snapshot's seat → player table (players tell us the team). */
export function humansFromSeats(w: World, controlled: readonly number[]): Human[] {
  const humans: Human[] = [];
  controlled.forEach((player, seat) => {
    if (player >= 0 && w.players[player]) humans.push({ seat, team: w.players[player].team, player });
  });
  return humans;
}
