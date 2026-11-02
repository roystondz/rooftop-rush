export type Team = 0 | 1;
export type Role = 'attacker' | 'midfielder' | 'keeper';
export type Phase = 'kickoff' | 'playing' | 'goal' | 'fulltime';
/** A normal match, or a penalty shootout on its own. */
export type GameMode = 'match' | 'penalties';

/** What one player wants to do this tick. Humans and bots both produce this. */
export interface Input {
  moveX: number; // -1..1
  moveZ: number; // -1..1
  sprint: boolean;
  shoot: boolean; // held to charge, released to shoot
  pass: boolean;
  /** Through ball: a pass into the space ahead of a teammate. Optional so older code can leave it out. */
  through?: boolean;
  tackle: boolean;
  /** Skill move with the ball: a sidestep, or a drag-back when pulling the stick backwards. */
  skill?: boolean;
  /** Held with pass, through or shoot: a lob pass, a lofted through ball, or a chip shot. */
  lob?: boolean;
}

export const NO_INPUT: Readonly<Input> = Object.freeze({
  moveX: 0,
  moveZ: 0,
  sprint: false,
  shoot: false,
  pass: false,
  tackle: false,
});

export interface Player {
  id: number;
  team: Team;
  role: Role;
  x: number;
  z: number;
  vx: number;
  vz: number;
  facing: number; // radians; direction is (cos, sin) in the x/z plane
  stamina: number; // 0..1
  sprinting: boolean;
  speedScale: number; // lets difficulty make bots a little slower or faster
  charging: boolean;
  charge: number; // seconds the shoot button has been held
  kickCooldown: number;
  tackleCooldown: number;
  stun: number;
  /** Seconds left of a goalkeeper's dive (penalties). */
  dive: number;
  /** Seconds left of a skill move; tackles miss while it lasts. */
  skillTimer: number;
  skillCooldown: number;
  /** Seconds left of a jump for a header (for drawing). */
  jump: number;
  prevSkill: boolean;
  prevShoot: boolean;
  prevPass: boolean;
  prevThrough: boolean;
  prevTackle: boolean;
}

export type KickKind = 'none' | 'shot' | 'pass';
/** How the ball was struck, when it wasn't a plain kick along the ground. */
export type KickStyle = 'header' | 'volley' | 'chip' | 'lob';

export interface Ball {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  spin: number; // positive curls toward +z relative to travel
  owner: number; // player id, or -1 when loose
  lastTouch: number;
  lastKick: { by: number; kind: KickKind; target: number; style?: KickStyle };
  power: boolean; // true while a Rush power shot is in flight
}

export type MatchEventType =
  | 'whistle'
  | 'kickoff'
  | 'penaltySetup'
  | 'penaltyMiss'
  | 'shot'
  | 'powerShot'
  | 'pass'
  | 'possession'
  | 'received'
  | 'save'
  | 'tackle'
  | 'skill'
  | 'bounce'
  | 'wall'
  | 'post'
  | 'net'
  | 'goal'
  | 'rushReady'
  | 'goldenGoal'
  | 'fulltime';

export interface MatchEvent {
  type: MatchEventType;
  player?: number;
  team?: Team;
  target?: number;
  strength?: number;
  ownGoal?: boolean;
  /** Shots, passes and goals that came from a header or a volley. */
  style?: KickStyle;
}

/** Penalty shootout progress. */
export interface Shootout {
  /** Team taking the current kick. */
  taker: Team;
  /** Each team's kicks so far, in order: 1 = scored, 0 = missed or saved. */
  kicks: [number[], number[]];
  /** Whether the current kick has been struck. */
  kicked: boolean;
  /** Seconds since the kick (or since the whistle, before it). */
  kickTimer: number;
}

export interface World {
  tick: number;
  mode: GameMode;
  /** Set in penalties mode. */
  shootout: Shootout | null;
  time: number; // seconds left on the clock
  phase: Phase;
  phaseTimer: number;
  score: [number, number];
  goldenGoal: boolean;
  /** A tie at full time ends the match as a draw instead of going to golden goal (tournament). */
  drawAllowed: boolean;
  kickoffTeam: Team;
  /** True after a kickoff until the kicking team's first pass. */
  kickoffPending: boolean;
  players: Player[];
  ball: Ball;
  rush: [number, number];
  events: MatchEvent[]; // what happened during the last step; cleared every step
  lastScorer: number;
  winner: Team | -1;
}
