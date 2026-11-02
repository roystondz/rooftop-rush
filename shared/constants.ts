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

/** Skill moves, headers, volleys and crosses. */
export const SKILL = {
  evadeTime: 0.35, // seconds a skill move makes tackles miss
  cooldown: 1.3,
  staminaCost: 0.12,
  sidestepSpeed: 6.5, // sideways burst of a step-over
  dragBackSpeed: 3.5, // backwards burst of a drag-back
  beatenStun: 0.6, // a defender who lunges at a skill move is left off balance this long

  headerMinHeight: 1.15, // the ball's height (metres) a player can head…
  headerMaxHeight: 2.6, // …up to this, with a jump
  headerReach: 1.25, // how close (sideways) the ball must be to head it
  headerSpeed: 17,
  headerPassSpeed: 12,
  headerLift: 0.4, // headers are aimed down: they bounce in front of the keeper
  jumpTime: 0.35,

  volleyMinHeight: 0.55, // a first-time shot on a ball above this is a volley…
  volleySpeed: 1.1, // …a little faster…
  volleyLift: 0.45, // …and much flatter than a normal shot

  crossLift: 9, // a cross is lofted to reach head height…
  crossFlight: 0.6, // …arriving about this many seconds later
  crossMaxSpeed: 24,
  crossMinDistance: 6,
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
  goalCelebration: 6.4, // long enough for the celebration and the replay (see REPLAY)
} as const;

/** Instant replay after a goal. The goal pause (MATCH.goalCelebration) must cover delay + the replay. */
export const REPLAY = {
  delay: 1.5, // seconds of live celebration before the replay starts
  before: 2.4, // replay starts this long before the ball went in…
  after: 0.5, // …and ends this long after
  slowFrom: 0.8, // the last moments before the goal play in slow motion
  slowSpeed: 0.45,
} as const;

export const SHOOTOUT = {
  kicksEach: 5, // then sudden death
  spotDistance: 4.5, // penalty spot, metres from the goal line
  aimLimit: 0.62, // radians either side of straight: a full turn reaches the corner, not the wall
  aimTurnRate: 2.2, // radians per second while aiming
  setupTime: 1.8, // pause before each kick
  timeLimit: 8, // seconds to take the kick before it's taken for you
  resultTime: 2.2, // pause after each kick
  settleTime: 2.5, // a kick that hasn't scored by now has missed
  keeperLineSpeed: 5.5, // keeper's shuffle along the line
  diveSpeed: 8,
  diveTime: 0.45,
  diveRecovery: 0.6, // time on the floor after a dive
  diveReach: 1.4,
  standingReach: 1.05, // a keeper who doesn't dive only saves shots close to them
} as const;

export const RUSH = {
  max: 100,
  pass: 6, // completed pass between teammates
  steal: 15, // successful tackle
} as const;
