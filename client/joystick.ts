// Pure joystick maths, kept apart from the DOM so it can be tested.

export interface StickReading {
  moveX: number; // -1..1, screen right is +x on the pitch
  moveZ: number; // -1..1, screen down is +z on the pitch
  magnitude: number; // 0..1
}

/** Below this fraction of the radius the stick counts as centred, so a resting thumb doesn't drift. */
export const DEADZONE = 0.15;
/** Pushing the stick past this fraction of the radius also sprints. */
export const SPRINT_PUSH = 0.92;

/**
 * Turns a thumb's offset from where it first touched (in pixels) into a move direction.
 * Movement ramps up smoothly from the dead zone to the edge of the stick.
 */
export function readStick(dx: number, dy: number, radius: number): StickReading {
  const dist = Math.hypot(dx, dy);
  if (radius <= 0 || dist / radius < DEADZONE) return { moveX: 0, moveZ: 0, magnitude: 0 };
  const magnitude = Math.min(1, (dist / radius - DEADZONE) / (1 - DEADZONE));
  return { moveX: (dx / dist) * magnitude, moveZ: (dy / dist) * magnitude, magnitude };
}

/** Where to draw the knob: following the thumb, but never outside the stick's ring. */
export function knobOffset(dx: number, dy: number, radius: number): { x: number; y: number } {
  const dist = Math.hypot(dx, dy);
  if (dist <= radius) return { x: dx, y: dy };
  return { x: (dx / dist) * radius, y: (dy / dist) * radius };
}

/** True on phones and tablets (a finger, not a mouse, is the main pointer). */
export function isTouchDevice(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
}
