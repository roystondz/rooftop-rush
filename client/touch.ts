// On-screen controls for phones and tablets: a floating joystick on the left half of the
// screen and action buttons on the right. Several fingers can be down at once.
import { knobOffset, readStick, SPRINT_PUSH } from './joystick';

const STICK_RADIUS = 56; // pixels

type Button = 'shoot' | 'pass' | 'tackle' | 'sprint' | 'switch';

export interface TouchState {
  moveX: number;
  moveZ: number;
  sprint: boolean;
  shoot: boolean; // held
  pass: boolean; // tapped since the last read
  tackle: boolean;
  switchPlayer: boolean;
}

export class TouchControls {
  readonly root: HTMLElement;
  private base: HTMLElement;
  private knob: HTMLElement;
  private stickPointer: number | null = null;
  private stickOrigin = { x: 0, y: 0 };
  private stick = { moveX: 0, moveZ: 0, magnitude: 0 };
  private held = new Set<Button>();
  private tapped = new Set<Button>();
  private buttonPointers = new Map<number, Button>();

  constructor() {
    this.root = document.getElementById('touch')!;
    this.base = this.root.querySelector<HTMLElement>('.stick-base')!;
    this.knob = this.root.querySelector<HTMLElement>('.stick-knob')!;

    const zone = this.root.querySelector<HTMLElement>('.stick-zone')!;
    zone.addEventListener('pointerdown', (e) => this.stickDown(e));
    zone.addEventListener('pointermove', (e) => this.stickMove(e));
    zone.addEventListener('pointerup', (e) => this.stickUp(e));
    zone.addEventListener('pointercancel', (e) => this.stickUp(e));

    this.root.querySelectorAll<HTMLElement>('[data-button]').forEach((el) => {
      const name = el.dataset.button as Button;
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        capture(el, e.pointerId);
        this.buttonPointers.set(e.pointerId, name);
        this.held.add(name);
        this.tapped.add(name);
        el.classList.add('down');
        navigator.vibrate?.(8);
      });
      const release = (e: PointerEvent) => {
        if (this.buttonPointers.get(e.pointerId) !== name) return;
        this.buttonPointers.delete(e.pointerId);
        if (![...this.buttonPointers.values()].includes(name)) {
          this.held.delete(name);
          el.classList.remove('down');
        }
      };
      el.addEventListener('pointerup', release);
      el.addEventListener('pointercancel', release);
    });

    // Long-presses must not open the browser's copy/save menu mid-match.
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  show(visible: boolean): void {
    this.root.classList.toggle('hidden', !visible);
    if (!visible) this.releaseAll();
  }

  /** Call once per game tick. Taps are reported once, even if they were shorter than a tick. */
  read(): TouchState {
    const state: TouchState = {
      moveX: this.stick.moveX,
      moveZ: this.stick.moveZ,
      sprint: this.held.has('sprint') || this.stick.magnitude >= SPRINT_PUSH,
      shoot: this.held.has('shoot') || this.tapped.has('shoot'),
      pass: this.tapped.has('pass'),
      tackle: this.tapped.has('tackle'),
      switchPlayer: this.tapped.has('switch'),
    };
    this.tapped.clear();
    return state;
  }

  private stickDown(e: PointerEvent): void {
    if (this.stickPointer !== null) return; // one thumb on the stick at a time
    e.preventDefault();
    capture(e.currentTarget as HTMLElement, e.pointerId);
    this.stickPointer = e.pointerId;
    // Floating stick: it appears wherever your thumb lands.
    this.stickOrigin = { x: e.clientX, y: e.clientY };
    this.base.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
    this.base.classList.add('active');
    this.updateStick(e);
  }

  private stickMove(e: PointerEvent): void {
    if (e.pointerId !== this.stickPointer) return;
    e.preventDefault();
    this.updateStick(e);
  }

  private stickUp(e: PointerEvent): void {
    if (e.pointerId !== this.stickPointer) return;
    this.stickPointer = null;
    this.stick = { moveX: 0, moveZ: 0, magnitude: 0 };
    this.knob.style.transform = 'translate(-50%, -50%)';
    this.base.classList.remove('active');
  }

  private updateStick(e: PointerEvent): void {
    const dx = e.clientX - this.stickOrigin.x;
    const dy = e.clientY - this.stickOrigin.y;
    this.stick = readStick(dx, dy, STICK_RADIUS);
    const k = knobOffset(dx, dy, STICK_RADIUS);
    this.knob.style.transform = `translate(calc(-50% + ${k.x}px), calc(-50% + ${k.y}px))`;
  }

  private releaseAll(): void {
    this.stickPointer = null;
    this.stick = { moveX: 0, moveZ: 0, magnitude: 0 };
    this.held.clear();
    this.tapped.clear();
    this.buttonPointers.clear();
    this.base.classList.remove('active');
    this.root.querySelectorAll('.down').forEach((el) => el.classList.remove('down'));
  }
}

/** Keeps a finger's events coming to this element even if it slides off. Harmless if unsupported. */
function capture(el: HTMLElement, pointerId: number): void {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    // e.g. the pointer already lifted; nothing to capture
  }
}
