import { describe, expect, it } from 'vitest';
import { pressToward } from '../shared/control';
import { packInput, parseClientMessage, unpackInput } from '../shared/protocol';
import { createWorld, step } from '../shared/sim';
import type { Input, World } from '../shared/types';

const idle: Input = { moveX: 0, moveZ: 0, sprint: false, shoot: false, pass: false, tackle: false };

/** You (id 0) have the ball in midfield; your teammate (id 1) is ahead, everyone else far away. */
function attacking(): World {
  const w = createWorld();
  Object.assign(w, { phase: 'playing', kickoffPending: false });
  w.players.forEach((p, i) => Object.assign(p, { x: -16 + i * 6, z: 10 }));
  Object.assign(w.players[0], { x: 0, z: 0, facing: 0 });
  Object.assign(w.players[1], { x: 6, z: -4, vx: 4, vz: 0 });
  Object.assign(w.ball, { x: 0.9, z: 0, owner: 0 });
  return w;
}

describe('through ball', () => {
  it('is played into the space ahead of the teammate, harder than a normal pass', () => {
    const normal = attacking();
    step(normal, [{ ...idle, pass: true }]);
    const through = attacking();
    step(through, [{ ...idle, through: true }]);
    expect(through.ball.lastKick.kind).toBe('pass');
    expect(through.ball.lastKick.target).toBe(1);
    // Aimed further toward the opponents' goal than the normal pass…
    const angle = (w: World) => Math.atan2(w.ball.vz, w.ball.vx);
    expect(Math.abs(angle(through))).toBeLessThan(Math.abs(angle(normal)));
    // …and hit harder.
    expect(Math.hypot(through.ball.vx, through.ball.vz)).toBeGreaterThan(Math.hypot(normal.ball.vx, normal.ball.vz));
  });

  it('travels online as its own button', () => {
    const packed = packInput({ ...idle, through: true });
    expect(unpackInput(packed).through).toBe(true);
    expect(parseClientMessage(JSON.stringify({ t: 'input', seq: 1, i: packed }))).not.toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: 'input', seq: 1, i: [0, 0, 32] }))).toBeNull();
  });
});

describe('press (hold to chase)', () => {
  it('runs you at the ball, a little ahead of where it is going', () => {
    const move = pressToward({ x: 0, z: 0 }, { x: 10, z: 0, vx: 0, vz: 8 });
    expect(move.moveX).toBeGreaterThan(0.9);
    expect(move.moveZ).toBeGreaterThan(0); // leading the ball's movement
    expect(move.sprint).toBe(true);
  });

  it('stops pushing once you are on the ball', () => {
    expect(pressToward({ x: 0, z: 0 }, { x: 0.1, z: 0, vx: 0, vz: 0 })).toEqual({ moveX: 0, moveZ: 0, sprint: false });
  });
});
