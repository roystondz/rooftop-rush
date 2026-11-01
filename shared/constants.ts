// Every tunable number in the game lives here, so balancing means editing one file.
// Units: metres, seconds, metres/second. The pitch runs along x (length) and z (width); y is up.

export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;

export const PITCH = {
  length: 40, // x from -20 to 20
  width: 24, // z from -12 to 12
  goalWidth: 7,
  goalHeight: 2.4,
  goalDepth: 1.8,
  postRadius: 0.1,
  boxDepth: 6, // keeper area, measured from the goal line
  boxHalfWidth: 6,
  centreCircle: 3, // opponents stay outside this until the kickoff pass
  ceiling: 9, // the cage has a net roof
} as const;

export const BALL = {
  radius: 0.3,
  gravity: 22,
  airDrag: 0.12, // fraction of horizontal speed lost per second in the air
  groundFriction: 1.1, // fraction of speed lost per second while rolling
  bounce: 0.55,
  minBounceSpeed: 1.6,
  wallBounce: 0.7,
  netBounce: 0.15,
  postBounce: 0.75,
  curlStrength: 3, // sideways acceleration per unit of spin
  spinDecay: 0.5,
  groundSpinDecay: 1.5, // extra spin lost per second while rolling
} as const;

export const PLAYER = {
  radius: 0.5,
  speed: 6.2,
  sprintSpeed: 8.8,
  dribbleSpeedFactor: 0.93,
  chargeSpeedFactor: 0.7,
  accel: 34,
  turnRate: 14, // radians per second
  chargeTurnRate: 2.6, // turning slowly while charging is what lets you curl a shot
  staminaDrain: 0.45,
  staminaRegen: 0.22,
  reach: 0.95, // how close the ball must be to control it
  firstTimeReach: 1.3, // how close a loose ball must be to hit it first time
  maxTrapSpeed: 18, // faster balls bounce off outfield players
  keeperReach: 1.6,
  keeperReachHeight: 2.3,
  kickCooldown: 0.3,
  tackleRange: 1.35,
  tackleLunge: 4,
  tackleCooldown: 0.9,
  stunTime: 0.7,
  missStun: 0.25,
  maxCharge: 0.9, // seconds of holding shoot for a full-power shot
} as const;

export const SHOT = {
  minSpeed: 13,
  maxSpeed: 27,
  minLift: 1.2,
  maxLift: 6.5,
  maxCurl: 3.2,
  powerMultiplier: 1.35,
  powerLift: 1.6,
} as const;

export const PASS = {
  minSpeed: 8,
  maxSpeed: 21,
  speedPerMeter: 1.2,
  lift: 0.8,
  loftDistance: 15, // passes longer than this are chipped
  loftLift: 6,
  lead: 0.35, // seconds of the receiver's run to aim ahead
  throughLead: 0.9, // through balls aim much further ahead…
  throughSpace: 3.5, // …and this many metres further toward goal
  throughSpeedFactor: 1.12,
  minDistance: 2,
} as const;

export const MATCH = {
  duration: 180,
  kickoffDelay: 1.6,
  kickoffPassTime: 6, // seconds to make the kickoff pass before it's made for you
  goalCelebration: 2.8,
} as const;

export const RUSH = {
  max: 100,
  pass: 6, // completed pass between teammates
  steal: 15, // successful tackle
} as const;
