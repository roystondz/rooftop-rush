// Turns match events into sounds, screen shake and HUD messages. Shared by local and online play.
import type { MatchEvent, Phase, Team, World } from '../shared/types';
import type { Sfx } from './audio';
import { DEFAULT_TEAM_NAMES } from '../shared/names';
import type { Hud } from './hud';
import { TEAM_COLORS, type Renderer } from './renderer';

export class Effects {
  myTeam: Team = 0;
  names: [string, string] = [...DEFAULT_TEAM_NAMES];
  /** How to tell the player to pass: "press K" on a keyboard, "tap PASS" on a phone. */
  passHint = 'press K';
  /** How to take a penalty, and how to save one, on this device. */
  penaltyHints = { take: 'aim with the arrows, hold J to shoot', save: 'A/D to move, L to dive' };
  onFullTime: (w: World) => void = () => {};
  /** Every match event, as it happens (used to keep your stats). */
  onEvent: (w: World, e: MatchEvent) => void = () => {};
  private lastPhase: Phase | null = null;

  constructor(
    private sfx: Sfx,
    private renderer: Renderer,
    private hud: Hud,
  ) {}

  reset(myTeam: Team): void {
    this.myTeam = myTeam;
    this.lastPhase = null;
  }

  /** Call whenever the world changes, so phase changes (like a new kickoff) get announced. */
  watchPhase(w: World): void {
    if (w.phase === this.lastPhase) return;
    if (w.phase === 'kickoff' && w.mode === 'match') this.hud.message('KICK OFF', '', 1.2);
    // The first kick is set up with the world, before any events reach us, so announce it here.
    if (this.lastPhase === null && w.mode === 'penalties' && w.shootout) this.announcePenalty(w, w.shootout.taker);
    if (w.phase === 'playing' && this.lastPhase === 'kickoff' && w.kickoffPending && w.kickoffTeam === this.myTeam) {
      this.hud.message('PASS TO START', `Turn to aim, then ${this.passHint}`, 1.8);
    }
    this.lastPhase = w.phase;
  }

  /** The replayed ball has just gone in: bulge the net and lift the crowd again. */
  replayGoal(w: World): void {
    this.renderer.pulseNet(w.ball.x);
    this.sfx.crowdSwell(0.6);
  }

  /** "YOUR PENALTY" or "SAVE IT!", with the kick number and how to shoot or save. */
  private announcePenalty(w: World, taker: Team): void {
    const kicks = w.shootout?.kicks;
    const n = kicks ? kicks[taker].length + 1 : 1;
    const ours = taker === this.myTeam;
    const title = ours ? 'YOUR PENALTY' : 'SAVE IT!';
    const hint = ours ? this.penaltyHints.take : this.penaltyHints.save;
    this.hud.message(title, `Kick ${n} · ${hint}`, 2);
  }

  handle(w: World, e: MatchEvent): void {
    this.onEvent(w, e);
    const ours = e.team === this.myTeam;
    switch (e.type) {
      case 'whistle':
        this.sfx.whistle(w.phase === 'fulltime');
        break;
      case 'shot':
        this.sfx.kick(e.strength ?? 0.5);
        this.renderer.addShake(0.15 * (e.strength ?? 0.5));
        break;
      case 'powerShot':
        this.sfx.powerKick();
        this.renderer.addShake(0.6);
        break;
      case 'pass':
        this.sfx.pass();
        break;
      case 'save':
        this.sfx.crowdSwell(0.8);
        this.hud.message('SAVE!', '', 0.9);
        break;
      case 'tackle':
        this.sfx.tackle();
        this.renderer.addShake(0.25);
        break;
      case 'bounce':
      case 'wall':
      case 'net':
        this.sfx.bounce(e.strength ?? 1);
        break;
      case 'post':
        this.sfx.post();
        this.sfx.crowdSwell(1);
        this.hud.message('POST!', '', 0.9);
        break;
      case 'goal': {
        const team = e.team ?? 0;
        this.sfx.goal();
        this.renderer.addShake(0.9);
        this.renderer.goalBurst(team, w.ball.x);
        const color = `#${TEAM_COLORS[team].toString(16).padStart(6, '0')}`;
        const sub = `${this.names[team]} · ${w.score[0]} – ${w.score[1]}`;
        if (w.mode === 'match') this.hud.goal(e.ownGoal ? 'OWN GOAL' : 'GOAL!', sub, color);
        else this.hud.message('GOAL!', sub, 2.4);
        break;
      }
      case 'rushReady':
        this.sfx.rushReady();
        if (ours) this.hud.message('RUSH READY', 'Your next shot is a power shot', 1.4);
        break;
      case 'penaltySetup':
        this.announcePenalty(w, e.team ?? 0);
        break;
      case 'penaltyMiss':
        this.sfx.crowdSwell(0.7);
        this.hud.message('MISSED!', '', 1.6);
        break;
      case 'goldenGoal':
        this.hud.message('GOLDEN GOAL', 'Next goal wins', 2);
        break;
      case 'fulltime':
        setTimeout(() => this.onFullTime(w), 1200);
        break;
      case 'possession':
      case 'received':
        break;
    }
  }
}
