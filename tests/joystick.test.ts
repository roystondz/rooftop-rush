import { describe, expect, it } from 'vitest';
import { DEADZONE, knobOffset, readStick, SPRINT_PUSH } from '../client/joystick';

const R = 56;

describe('touch joystick', () => {
  it('ignores tiny thumb movements inside the dead zone', () => {
    expect(readStick(R * DEADZONE * 0.9, 0, R)).toEqual({ moveX: 0, moveZ: 0, magnitude: 0 });
  });

  it('maps screen right to +x and screen down to +z on the pitch', () => {
    const right = readStick(R, 0, R);
    expect(right.moveX).toBeCloseTo(1);
    expect(right.moveZ).toBeCloseTo(0);
    const down = readStick(0, R, R);
    expect(down.moveZ).toBeCloseTo(1);
    const upLeft = readStick(-R, -R, R);
    expect(upLeft.moveX).toBeLessThan(0);
    expect(upLeft.moveZ).toBeLessThan(0);
  });

  it('ramps up smoothly from the dead zone to the edge', () => {
    const a = readStick(R * 0.3, 0, R).magnitude;
    const b = readStick(R * 0.6, 0, R).magnitude;
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(b).toBeLessThan(1);
  });

  it('never goes past full speed when the thumb leaves the ring', () => {
    const far = readStick(R * 3, R * 4, R);
    expect(far.magnitude).toBe(1);
    expect(Math.hypot(far.moveX, far.moveZ)).toBeCloseTo(1);
  });

  it('counts a push to the edge as sprinting', () => {
    expect(readStick(R, 0, R).magnitude).toBeGreaterThanOrEqual(SPRINT_PUSH);
    expect(readStick(R * 0.7, 0, R).magnitude).toBeLessThan(SPRINT_PUSH);
  });

  it('keeps the drawn knob inside the ring', () => {
    expect(knobOffset(10, 0, R)).toEqual({ x: 10, y: 0 });
    const k = knobOffset(R * 2, 0, R);
    expect(k.x).toBeCloseTo(R);
  });
});
