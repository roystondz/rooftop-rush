import type { Input } from '../shared/types';
import type { TouchControls } from './touch';

export interface FrameInput {
  game: Input;
  switchPlayer: boolean;
  /** Held "press": the game steers you toward the ball (see pressToward). */
  press: boolean;
}

const KEYS = {
  up: ['KeyW', 'ArrowUp'],
  down: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  shoot: ['KeyJ', 'Space'],
  pass: ['KeyK'],
  through: ['KeyI'],
  press: ['KeyE'],
  tackle: ['KeyL'],
  switchPlayer: ['KeyQ'],
} as const;

type Action = keyof typeof KEYS;

const GAME_KEYS = new Set<string>(Object.values(KEYS).flat());

/**
 * Turns keyboard, gamepad and on-screen touch controls into one Input per game tick.
 * Key presses are latched, so a tap shorter than one tick is never lost.
 */
export class InputManager {
  private down = new Set<string>();
  private pressed = new Set<string>(); // pressed since the last read
  /** Set on phones and tablets. */
  touch: TouchControls | null = null;

  constructor(target: Window = window) {
    target.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return; // typing in a text box, not playing
      if (GAME_KEYS.has(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.down.add(e.code);
      this.pressed.add(e.code);
    });
    target.addEventListener('keyup', (e) => this.down.delete(e.code));
    target.addEventListener('blur', () => this.down.clear());
  }

  /** Call once per tick. */
  read(): FrameInput {
    const held = (a: Action) => KEYS[a].some((k) => this.down.has(k));
    const tapped = (a: Action) => KEYS[a].some((k) => this.pressed.has(k));

    let moveX = (held('right') ? 1 : 0) - (held('left') ? 1 : 0);
    let moveZ = (held('down') ? 1 : 0) - (held('up') ? 1 : 0);
    let sprint = held('sprint');
    let shoot = held('shoot') || tapped('shoot');
    let pass = tapped('pass');
    let through = tapped('through');
    let press = held('press');
    let tackle = tapped('tackle');
    let switchPlayer = tapped('switchPlayer');

    const pad = firstGamepad();
    if (pad) {
      const ax = pad.axes[0] ?? 0;
      const az = pad.axes[1] ?? 0;
      if (Math.hypot(ax, az) > 0.2) {
        moveX = ax;
        moveZ = az;
      }
      const btn = (i: number) => pad.buttons[i]?.pressed ?? false;
      sprint ||= btn(7) || btn(5);
      shoot ||= btn(2);
      pass ||= this.padEdge(0, btn(0));
      through ||= this.padEdge(3, btn(3));
      press ||= btn(6);
      tackle ||= this.padEdge(1, btn(1));
      switchPlayer ||= this.padEdge(4, btn(4));
    }

    if (this.touch) {
      const t = this.touch.read();
      if (t.moveX !== 0 || t.moveZ !== 0) {
        moveX = t.moveX;
        moveZ = t.moveZ;
      }
      sprint ||= t.sprint;
      shoot ||= t.shoot;
      pass ||= t.pass;
      through ||= t.through;
      press ||= t.press;
      tackle ||= t.tackle;
      switchPlayer ||= t.switchPlayer;
    }

    this.pressed.clear();
    return { game: { moveX, moveZ, sprint, shoot, pass, tackle, through }, switchPlayer, press };
  }

  private padPrev = new Map<number, boolean>();
  private padEdge(button: number, isDown: boolean): boolean {
    const was = this.padPrev.get(button) ?? false;
    this.padPrev.set(button, isDown);
    return isDown && !was;
  }
}

function firstGamepad(): Gamepad | null {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
  for (const pad of navigator.getGamepads()) if (pad && pad.connected) return pad;
  return null;
}
