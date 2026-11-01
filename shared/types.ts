export type Team = 0 | 1;
export type Role = 'attacker' | 'midfielder' | 'keeper';
export type Phase = 'kickoff' | 'playing' | 'goal' | 'fulltime';

/** What one player wants to do this tick. Humans and bots both produce this. */
export interface Input {
  moveX: number; // -1..1
  moveZ: number; // -1..1
  sprint: boolean;
  shoot: boolean; // held to charge, released to shoot
  pass: boolean;
  tackle: boolean;
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
  prevShoot: boolean;
  prevPass: boolean;
  prevTackle: boolean;
}

export type KickKind = 'none' | 'shot' | 'pass';

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
  lastKick: { by: number; kind: KickKind; target: number };
  power: boolean; // true while a Rush power shot is in flight
}

export type MatchEventType =
  | 'whistle'
  | 'kickoff'
  | 'shot'
  | 'powerShot'
  | 'pass'
  | 'possession'
  | 'received'
  | 'save'
  | 'tackle'
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
}

export interface World {
  tick: number;
  time: number; // seconds left on the clock
  phase: Phase;
  phaseTimer: number;
  score: [number, number];
  goldenGoal: boolean;
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
