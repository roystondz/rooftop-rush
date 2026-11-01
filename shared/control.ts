// Which player each human controls. Used by the local game and by the server, so both behave the same.
import type { MatchEvent, Team, World } from './types';

/** `controlled[team]` is the player id a human controls on that team, or -1 when that team is all bots. */
export type Controlled = number[];

/** A player a human just stopped or started controlling; its bot brain should forget what it was doing. */
export type Handover = { from: number; to: number };

/**
 * Follows the ball automatically: when you pass, you take over the receiver; when a teammate
 * wins the ball, you take over them.
 */
export function autoSwitch(controlled: Controlled, events: readonly MatchEvent[]): Handover[] {
  const changes: Handover[] = [];
  for (const e of events) {
    if (e.team === undefined || e.player === undefined) continue;
    const current = controlled[e.team];
    if (current === undefined || current < 0) continue;
    let next = current;
    if (e.type === 'pass' && e.player === current && e.target !== undefined && e.target >= 0) next = e.target;
    if (e.type === 'possession' && e.player !== current) next = e.player;
    if (next !== current) {
      controlled[e.team] = next;
      changes.push({ from: current, to: next });
    }
  }
  return changes;
}

/** Switch button: take over the outfield teammate nearest the ball (not while you have it). */
export function switchToNearest(w: World, controlled: Controlled, team: Team): Handover | null {
  const current = controlled[team];
  if (current === undefined || current < 0 || w.ball.owner === current) return null;
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
  if (best < 0) return null;
  controlled[team] = best;
  return { from: current, to: best };
}
