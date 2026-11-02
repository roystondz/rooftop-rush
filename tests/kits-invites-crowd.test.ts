import { describe, expect, it } from 'vitest';
import { Crowd, headingForGoal } from '../client/crowd';
import { inviteLink, roomFromUrl } from '../client/net';
import { BALL, DT, PITCH } from '../shared/constants';
import { cleanKit, KITS, kitCss, teamKits } from '../shared/kits';
import { parseClientMessage } from '../shared/protocol';
import { createWorld } from '../shared/sim';
import type { World } from '../shared/types';

describe('kits', () => {
  it('keeps the classic colours when nobody chooses', () => {
    expect(teamKits(undefined, undefined)).toEqual([0, 1]);
  });

  it('lets the second team keep its choice unless it clashes', () => {
    expect(teamKits(3, 4)).toEqual([3, 4]);
    expect(teamKits(3, 3)).toEqual([3, 1]);
    expect(teamKits(1, 1)).toEqual([1, 0]);
    expect(teamKits(1, undefined)).toEqual([1, 0]);
  });

  it('rejects anything that is not a kit', () => {
    for (const bad of [-1, KITS.length, 1.5, '2', null, NaN]) expect(cleanKit(bad, 0)).toBe(0);
    expect(cleanKit(KITS.length - 1, 0)).toBe(KITS.length - 1);
  });

  it('gives CSS colours with six hex digits', () => {
    KITS.forEach((_, i) => expect(kitCss(i)).toMatch(/^#[0-9a-f]{6}$/));
  });

  it('passes a valid kit through the protocol and drops a bad one', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'quick', kit: 4 }))).toEqual({ t: 'quick', kit: 4 });
    expect(parseClientMessage(JSON.stringify({ t: 'join', code: 'abcd', kit: 2 }))).toEqual({ t: 'join', code: 'ABCD', kit: 2 });
    expect(parseClientMessage(JSON.stringify({ t: 'create', kit: 'red' }))).toEqual({ t: 'create' });
    expect(parseClientMessage(JSON.stringify({ t: 'create', kit: 1e9 }))).toEqual({ t: 'create' });
  });
});

describe('invite links', () => {
  it('reads a room code from the link', () => {
    expect(roomFromUrl('?room=abcd')).toBe('ABCD');
    expect(roomFromUrl('?lag=100&room=WXYZ')).toBe('WXYZ');
  });

  it('ignores anything that is not a room code', () => {
    for (const q of ['', '?room=', '?room=ABC', '?room=ABCDE', '?room=AB1D', '?room=<b>']) expect(roomFromUrl(q)).toBeNull();
  });

  it('builds a link back to this page', () => {
    expect(inviteLink('ABCD', { origin: 'https://rooftop-rush.onrender.com', pathname: '/' })).toBe(
      'https://rooftop-rush.onrender.com/?room=ABCD',
    );
  });
});

/** A world in open play with the ball loose. */
function playing(): World {
  const w = createWorld();
  w.phase = 'playing';
  w.kickoffPending = false;
  w.players.forEach((p, i) => Object.assign(p, { x: -15 + i * 5, z: 10 }));
  return w;
}
const HALF_L = PITCH.length / 2;
const GOAL_HALF = PITCH.goalWidth / 2;

describe('crowd', () => {
  it('rises for a shot on target, but not for one going nowhere near', () => {
    const w = playing();
    Object.assign(w.ball, { x: 12, z: 0, vx: 20, vz: 1 });
    expect(headingForGoal(w, 0)).toBe(true);
    expect(headingForGoal(w, 1)).toBe(false); // that's team 1's own goal
    Object.assign(w.ball, { x: 12, z: 0, vx: 20, vz: 20 });
    expect(headingForGoal(w, 0)).toBe(false); // way wide
    Object.assign(w.ball, { x: -15, z: 0, vx: 20, vz: 0 });
    expect(headingForGoal(w, 0)).toBe(false); // from too far out
  });

  it('groans when a shot goes just wide, and only once', () => {
    const w = playing();
    const crowd = new Crowd();
    Object.assign(w.ball, { x: 14, z: 1, vx: 20, vz: 1.2 });
    expect(crowd.event(w, { type: 'shot', player: 0, team: 0 })).toEqual(['rise']);
    Object.assign(w.ball, { x: HALF_L - BALL.radius, z: GOAL_HALF + 0.6 });
    w.tick += 20;
    expect(crowd.watch(w)).toContain('groan');
    w.tick += 1;
    expect(crowd.watch(w)).not.toContain('groan');
  });

  it('does not groan after a save or a goal', () => {
    for (const settled of ['save', 'goal'] as const) {
      const w = playing();
      const crowd = new Crowd();
      Object.assign(w.ball, { x: 14, z: 1, vx: 20, vz: 1.2 });
      crowd.event(w, { type: 'shot', player: 0, team: 0 });
      crowd.event(w, { type: settled, player: 2, team: 1 });
      Object.assign(w.ball, { x: HALF_L - BALL.radius, z: GOAL_HALF + 0.6 });
      expect(crowd.watch(w)).not.toContain('groan');
    }
  });

  it('murmurs when an attacker carries the ball into the box, not every tick', () => {
    const w = playing();
    const crowd = new Crowd();
    const attacker = w.players[0];
    Object.assign(attacker, { x: HALF_L - 3, z: 0 });
    w.ball.owner = attacker.id;
    expect(crowd.watch(w)).toContain('murmur');
    w.tick += 1;
    expect(crowd.watch(w)).not.toContain('murmur');
    // Defending in your own box is no reason to murmur.
    const fresh = new Crowd();
    Object.assign(attacker, { x: -HALF_L + 3 });
    expect(fresh.watch(w)).not.toContain('murmur');
  });

  it('claps once for the last 30 seconds, and applauds at full time', () => {
    const w = playing();
    const crowd = new Crowd();
    w.time = 31;
    expect(crowd.watch(w)).not.toContain('finale');
    w.time = 30 - DT;
    expect(crowd.watch(w)).toContain('finale');
    expect(crowd.watch(w)).not.toContain('finale');
    expect(crowd.event(w, { type: 'fulltime' })).toEqual(['applause']);
  });

  it('stays quiet in penalty shootouts apart from the applause', () => {
    const w = createWorld({ mode: 'penalties' });
    const crowd = new Crowd();
    w.time = 10;
    expect(crowd.watch(w)).toEqual([]);
    expect(crowd.event(w, { type: 'shot', player: 0, team: 0 })).toEqual([]);
  });
});
