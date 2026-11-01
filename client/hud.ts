import { PLAYER, RUSH } from '../shared/constants';
import type { Player, World } from '../shared/types';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export const TEAM_NAMES = ['SKYLINE', 'NEON'] as const;

export class Hud {
  private root = $('hud');
  private score = [$('score-0'), $('score-1')];
  private rush = [$('rush-0'), $('rush-1')];
  private clock = $('clock');
  private msg = $('message');
  private charge = $('charge');
  private stamina = $('stamina');
  private ping = $('ping');
  private teamLabels = [$('name-0'), $('name-1')];
  private msgTimer = 0;

  /** `you` marks which team is yours in online play; leave it out for local games. */
  show(you?: 0 | 1): void {
    this.root.classList.remove('hidden');
    this.teamLabels.forEach((el, t) => el.classList.toggle('you', t === you));
    this.ping.classList.toggle('hidden', you === undefined);
  }

  /** Network readout in the corner during online play. */
  setNet(text: string): void {
    this.ping.textContent = text;
  }

  hide(): void {
    this.root.classList.add('hidden');
  }

  message(text: string, sub = '', seconds = 1.6): void {
    this.msg.innerHTML = '';
    this.msg.append(text);
    if (sub) {
      const s = document.createElement('small');
      s.textContent = sub;
      this.msg.append(s);
    }
    this.msg.classList.add('show');
    this.msgTimer = seconds;
  }

  update(w: World, controlled: Player | undefined, frameDt: number): void {
    for (const t of [0, 1] as const) {
      this.score[t].textContent = String(w.score[t]);
      const pct = (w.rush[t] / RUSH.max) * 100;
      this.rush[t].style.width = `${pct}%`;
      this.rush[t].parentElement!.classList.toggle('full', pct >= 100);
    }
    if (w.goldenGoal) {
      this.clock.textContent = 'GOLDEN GOAL';
      this.clock.classList.add('golden');
    } else {
      const s = Math.ceil(w.time);
      this.clock.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      this.clock.classList.remove('golden');
    }
    if (controlled) {
      this.charge.style.width = `${controlled.charging ? (controlled.charge / PLAYER.maxCharge) * 100 : 0}%`;
      this.stamina.style.width = `${controlled.stamina * 100}%`;
    }
    if (this.msgTimer > 0) {
      this.msgTimer -= frameDt;
      if (this.msgTimer <= 0) this.msg.classList.remove('show');
    }
  }
}
