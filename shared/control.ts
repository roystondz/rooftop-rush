// Which player each human controls. Used by the local game and by the server, so both behave the same.
import type { MatchEvent, Team, World } from './types';

/** `controlled[team]` is the player id a human controls on that team, or -1 when that team is all bots. */
export type Controlled = number[];

/** A player a human just stopped or started controlling; its bot brain should forget what it was doing. */
export type Handover = { from: number; to: number };

/** Ticks after any switch before an automatic defensive switch may happen (stops flickering). */
const AUTO_SWITCH_COOLDOWN = 45;
/** Switch automatically only when you are at least this far from the ball… */
const AUTO_SWITCH_MIN_DISTANCE = 5;
/** …and a teammate is at least this much closer. */
const AUTO_SWITCH_ADVANTAGE = 3;

/** Remembers when each team last switched, so automatic switching can't undo a manual one at once. */
export class SwitchTimer {
  private last: number[] = [-Infinity, -Infinity];

  mark(w: World, team: Team): void {
    this.last[team] = w.tick;
  }

  ready(w: World, team: Team): boolean {
    return w.tick - this.last[team] >= AUTO_SWITCH_COOLDOWN;
  }
}

/**
 * Follows the ball automatically: when you pass, you take over the receiver; when a teammate
 * wins the ball, you take over them; at each kickoff you take your attacker again.
 */
export function autoSwitch(
  w: World,
  controlled: Controlled,
  events: readonly MatchEvent[],
  timer?: SwitchTimer,
): Handover[] {
  const changes: Handover[] = [];
  const set = (team: Team, next: number) => {
    const current = controlled[team];
    if (current === undefined || current < 0 || next === current) return;
    controlled[team] = next;
    timer?.mark(w, team); // so the defending switch can't immediately undo this one
    changes.push({ from: current, to: next });
  };
  for (const e of events) {
    if (e.type === 'kickoff') {
      for (const team of [0, 1] as const) {
        const attacker = w.players.find((p) => p.team === team && p.role === 'attacker');
        if (attacker) set(team, attacker.id);
      }
      continue;
    }
    if (e.team === undefined || e.player === undefined) continue;
    const current = controlled[e.team];
    if (e.type === 'pass' && e.player === current && e.target !== undefined && e.target >= 0) set(e.team, e.target);
    if (e.type === 'possession' && e.player !== current) set(e.team, e.player);
  }
  return changes;
}

/** The teammate the switch button would pick: the outfield player nearest the ball, other than you. */
export function switchTarget(w: World, controlled: Controlled, team: Team): number {
  const current = controlled[team];
  if (current === undefined || current < 0) return -1;
  let best = -1;
  let bestD = Infinity;
  for (const p of w.players) {
    if (p.team !== team || p.role === 'keeper' || p.id === current) continue;
    const d = Math.hypot(p.x - w.ball.x, p.z - w.ball.z);
    if (d < bestD) {
      best = p.id;
      bestD = d;
    }
  }
  return best;
}

/** Switch button: take over the teammate nearest the ball (not while you have it). */
export function switchToNearest(w: World, controlled: Controlled, team: Team, timer?: SwitchTimer): Handover | null {
  const current = controlled[team];
  if (current === undefined || current < 0 || w.ball.owner === current) return null;
  const best = switchTarget(w, controlled, team);
  if (best < 0) return null;
  controlled[team] = best;
  timer?.mark(w, team);
  return { from: current, to: best };
}

/**
 * Defending: when the other team has the ball (or it's loose) and a teammate is much closer to it
 * than you, take over that teammate so you can get the tackle in.
 */
export function autoSwitchDefending(w: World, controlled: Controlled, team: Team, timer: SwitchTimer): Handover | null {
  const current = controlled[team];
  if (current === undefined || current < 0 || w.phase !== 'playing' || w.kickoffPending) return null;
  const b = w.ball;
  if (b.owner >= 0 && w.players[b.owner].team === team) return null; // we have it
  // Our own pass or shot is still travelling: that's not defending.
  if (b.owner < 0 && b.lastTouch >= 0 && w.players[b.lastTouch].team === team) return null;
  if (!timer.ready(w, team)) return null;

  const me = w.players[current];
  const myDistance = Math.hypot(me.x - b.x, me.z - b.z);
  if (myDistance < AUTO_SWITCH_MIN_DISTANCE) return null;
  const best = switchTarget(w, controlled, team);
  if (best < 0) return null;
  const p = w.players[best];
  if (Math.hypot(p.x - b.x, p.z - b.z) > myDistance - AUTO_SWITCH_ADVANTAGE) return null;

  controlled[team] = best;
  timer.mark(w, team);
  return { from: current, to: best };
}
