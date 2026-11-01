import { PLAYER, RUSH, SHOOTOUT } from '../shared/constants';
import type { Player, World } from '../shared/types';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;


export class Hud {
  private root = $('hud');
  private score = [$('score-0'), $('score-1')];
  private rush = [$('rush-0'), $('rush-1')];
  private clock = $('clock');
  private msg = $('message');
  private charge = $('charge');
  private stamina = $('stamina');
  private ping = $('ping');
  private pens = [$('pens-0'), $('pens-1')];
  private pensShown = '';
  private teamLabels = [$('name-0'), $('name-1')];
  private msgTimer = 0;

  /** `you` marks which team is yours in online play; leave it out for local games. */
  setTeamNames(names: readonly [string, string]): void {
    this.teamLabels.forEach((el, t) => (el.textContent = names[t]));
  }

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
    this.root.classList.toggle('penalties', w.mode === 'penalties');
    if (w.mode === 'penalties' && w.shootout) {
      const kicks = w.shootout.kicks;
      const round = Math.min(kicks[0].length, kicks[1].length) + 1;
      this.clock.textContent = round > SHOOTOUT.kicksEach ? 'SUDDEN DEATH' : 'PENALTIES';
      this.clock.classList.add('golden');
      this.showPenaltyDots(kicks);
    } else if (w.goldenGoal) {
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

  /** Green dot = scored, red = missed or saved, hollow = still to take (first five). */
  private showPenaltyDots(kicks: readonly [readonly number[], readonly number[]]): void {
    const key = JSON.stringify(kicks);
    if (key === this.pensShown) return;
    this.pensShown = key;
    const shown = Math.max(SHOOTOUT.kicksEach, kicks[0].length, kicks[1].length);
    kicks.forEach((list, t) => {
      const el = this.pens[t];
      el.innerHTML = '';
      for (let i = 0; i < shown; i++) {
        const dot = document.createElement('span');
        if (i < list.length) dot.className = list[i] ? 'scored' : 'missed';
        el.append(dot);
      }
    });
  }
}
