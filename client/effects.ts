// Turns match events into sounds, screen shake and HUD messages. Shared by local and online play.
import type { MatchEvent, Phase, Team, World } from '../shared/types';
import type { Sfx } from './audio';
import { TEAM_NAMES, type Hud } from './hud';
import type { Renderer } from './renderer';

export class Effects {
  myTeam: Team = 0;
  onFullTime: (w: World) => void = () => {};
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
    if (w.phase === 'kickoff') this.hud.message('KICK OFF', '', 1.2);
    this.lastPhase = w.phase;
  }

  handle(w: World, e: MatchEvent): void {
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
        this.hud.message(e.ownGoal ? 'OWN GOAL' : 'GOAL!', `${TEAM_NAMES[team]} ${w.score[0]} – ${w.score[1]}`, 2.4);
        break;
      }
      case 'rushReady':
        this.sfx.rushReady();
        if (ours) this.hud.message('RUSH READY', 'Your next shot is a power shot', 1.4);
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
