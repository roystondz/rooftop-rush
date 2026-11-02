// On-screen controls for phones and tablets: a floating joystick on the left half of the
// screen and four action buttons on the right. Like FC Mobile and eFootball, the buttons change
// job with the situation: shoot/pass/through ball when your team has the ball, tackle/switch/
// press when defending, and shoot or dive during penalties. Several fingers can be down at once.
import { knobOffset, readStick, SPRINT_PUSH } from './joystick';

const STICK_RADIUS = 56; // pixels
/** Swiping up this far on SHOOT, PASS or THROUGH makes it a chip, a lob, or a lofted through ball. */
const LOB_SWIPE = 28; // pixels
/** Buttons that can be swiped up for the lofted version. */
const LOBBABLE = new Set<string>(['shoot', 'pass', 'through']);

export type Action = 'shoot' | 'pass' | 'through' | 'tackle' | 'switch' | 'press' | 'sprint' | 'skill';
type Slot = 'main' | 'second' | 'third' | 'fourth';
export type TouchMode = 'attack' | 'defend' | 'penaltyTaker' | 'penaltyKeeper' | 'idle';

interface ButtonJob {
  action: Action;
  label: string;
  hint?: string; // small text under the label
}

/** What each button does in each situation. A missing slot is hidden. */
const LAYOUTS: Record<TouchMode, Partial<Record<Slot, ButtonJob>>> = {
  attack: {
    main: { action: 'shoot', label: 'SHOOT', hint: 'hold · swipe ↑ chip' },
    second: { action: 'pass', label: 'PASS', hint: 'swipe ↑ lob' },
    third: { action: 'through', label: 'THROUGH', hint: 'swipe ↑ lob' },
    // Sprinting is also pushing the stick to its edge, so this button can be the skill move.
    fourth: { action: 'skill', label: 'SKILL', hint: 'pull back = turn' },
  },
  defend: {
    main: { action: 'tackle', label: 'TACKLE' },
    second: { action: 'switch', label: 'SWITCH', hint: 'Q' },
    third: { action: 'press', label: 'PRESS', hint: 'hold' },
    fourth: { action: 'sprint', label: 'SPRINT' },
  },
  penaltyTaker: {
    main: { action: 'shoot', label: 'SHOOT', hint: 'hold' },
  },
  penaltyKeeper: {
    main: { action: 'tackle', label: 'DIVE', hint: 'stick = side' },
  },
  idle: {},
};

export interface TouchState {
  moveX: number;
  moveZ: number;
  sprint: boolean;
  shoot: boolean; // held
  press: boolean; // held
  pass: boolean; // tapped since the last read
  through: boolean;
  tackle: boolean;
  skill: boolean;
  /** A button was swiped up: lob pass, lofted through ball, or chip shot. */
  lob: boolean;
  switchPlayer: boolean;
}

export class TouchControls {
  readonly root: HTMLElement;
  mode: TouchMode = 'attack';
  private base: HTMLElement;
  private knob: HTMLElement;
  private buttons = new Map<Slot, HTMLButtonElement>();
  private stickPointer: number | null = null;
  private stickOrigin = { x: 0, y: 0 };
  private stick = { moveX: 0, moveZ: 0, magnitude: 0 };
  private held = new Set<Action>();
  private tapped = new Set<Action>();
  /** Which action each finger pressed, decided when it touched down (so a mode change mid-press is safe). */
  private fingers = new Map<number, { action: Action; slot: Slot; startY: number; lob: boolean }>();
  /** A swiped pass or shot was let go since the last read: report lob with it. */
  private lobTap = false;

  constructor() {
    this.root = document.getElementById('touch')!;
    this.base = this.root.querySelector<HTMLElement>('.stick-base')!;
    this.knob = this.root.querySelector<HTMLElement>('.stick-knob')!;

    const zone = this.root.querySelector<HTMLElement>('.stick-zone')!;
    zone.addEventListener('pointerdown', (e) => this.stickDown(e));
    zone.addEventListener('pointermove', (e) => this.stickMove(e));
    zone.addEventListener('pointerup', (e) => this.stickUp(e));
    zone.addEventListener('pointercancel', (e) => this.stickUp(e));

    this.root.querySelectorAll<HTMLButtonElement>('[data-slot]').forEach((el) => {
      const slot = el.dataset.slot as Slot;
      this.buttons.set(slot, el);
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const job = LAYOUTS[this.mode][slot];
        if (!job) return;
        capture(el, e.pointerId);
        this.fingers.set(e.pointerId, { action: job.action, slot, startY: e.clientY, lob: false });
        this.held.add(job.action);
        // Pass and through ball go when you let go, so a swipe up can turn them into lobs first.
        if (job.action !== 'pass' && job.action !== 'through') this.tapped.add(job.action);
        el.classList.add('down');
        navigator.vibrate?.(8);
      });
      el.addEventListener('pointermove', (e) => {
        const finger = this.fingers.get(e.pointerId);
        if (!finger || finger.lob || !LOBBABLE.has(finger.action)) return;
        if (finger.startY - e.clientY > LOB_SWIPE) {
          finger.lob = true;
          el.classList.add('lob');
          navigator.vibrate?.(6);
        }
      });
      const release = (e: PointerEvent) => {
        const finger = this.fingers.get(e.pointerId);
        if (!finger) return;
        this.fingers.delete(e.pointerId);
        if (finger.action === 'pass' || finger.action === 'through') this.tapped.add(finger.action);
        if (finger.lob) this.lobTap = true;
        el.classList.remove('lob');
        const stillHeld = [...this.fingers.values()];
        if (!stillHeld.some((f) => f.action === finger.action)) this.held.delete(finger.action);
        if (!stillHeld.some((f) => f.slot === finger.slot)) el.classList.remove('down');
      };
      el.addEventListener('pointerup', release);
      el.addEventListener('pointercancel', release);
    });

    // Long-presses must not open the browser's copy/save menu mid-match.
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    this.setMode('attack', true);
  }

  show(visible: boolean): void {
    this.root.classList.toggle('hidden', !visible);
    if (!visible) this.releaseAll();
  }

  /** Relabels the buttons for the situation (attacking, defending, penalties). */
  setMode(mode: TouchMode, force = false): void {
    if (mode === this.mode && !force) return;
    this.mode = mode;
    this.root.dataset.mode = mode;
    for (const [slot, el] of this.buttons) {
      const job = LAYOUTS[mode][slot];
      el.classList.toggle('gone', !job);
      el.dataset.action = job?.action ?? '';
      el.innerHTML = '';
      if (!job) continue;
      el.append(job.label);
      if (job.hint) {
        const small = document.createElement('small');
        small.textContent = job.hint;
        el.append(small);
      }
    }
  }

  /** Call once per game tick. Taps are reported once, even if they were shorter than a tick. */
  read(): TouchState {
    const state: TouchState = {
      moveX: this.stick.moveX,
      moveZ: this.stick.moveZ,
      sprint: this.held.has('sprint') || this.stick.magnitude >= SPRINT_PUSH,
      shoot: this.held.has('shoot') || this.tapped.has('shoot'),
      press: this.held.has('press'),
      pass: this.tapped.has('pass'),
      through: this.tapped.has('through'),
      tackle: this.tapped.has('tackle'),
      skill: this.tapped.has('skill'),
      lob: this.lobTap || [...this.fingers.values()].some((f) => f.lob),
      switchPlayer: this.tapped.has('switch'),
    };
    this.tapped.clear();
    this.lobTap = false;
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
    this.fingers.clear();
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
