// Draws the "Your stats" screen from the stats saved on this device. Team names come from
// players, so everything is set with textContent, never as HTML.
import { OPPONENTS, totals, type Opponent, type RecentResult, type Stats, type Tally } from './stats';

const $ = (id: string) => document.getElementById(id)!;

const OPPONENT_LABEL: { [K in Opponent]: string } = {
  easy: 'Easy bots',
  normal: 'Normal bots',
  hard: 'Hard bots',
  online: 'Online',
};

export function renderStats(s: Stats): void {
  const all = totals(s);
  const empty = all.played === 0;
  $('stat-empty').classList.toggle('hidden', !empty);
  $('stat-body').classList.toggle('hidden', empty);
  $('stats-reset').classList.toggle('hidden', empty);

  const tiles = $('stat-tiles');
  tiles.replaceChildren(
    tile(String(all.played), 'Played'),
    tile(all.played ? `${Math.round((all.won / all.played) * 100)}%` : '–', 'Won'),
    tile(String(s.yourGoals), 'Your goals'),
    tile(String(s.bestStreak), 'Best streak'),
  );
  if (empty) return;

  table($('stat-matches'), ['', 'P', 'W', 'D', 'L', 'Goals'], s.matches, (r) => [r.played, r.won, r.drawn, r.lost, `${r.goalsFor}–${r.goalsAgainst}`]);
  table($('stat-shootouts'), ['', 'P', 'W', 'L', 'Pens'], s.shootouts, (r) => [r.played, r.won, r.lost, `${r.goalsFor}–${r.goalsAgainst}`]);

  const p = s.pens;
  const parts: string[] = [];
  if (p.taken) parts.push(`Your kicks: ${p.scored} of ${p.taken} scored`);
  if (p.faced) parts.push(`In goal: ${p.saved} of ${p.faced} kept out`);
  $('stat-pens').textContent = parts.join(' · ');

  const best: string[] = [];
  if (s.streak >= 2) best.push(`On a ${s.streak}-win streak`);
  if (s.biggestWin) best.push(`Biggest win: ${s.biggestWin.line}`);
  $('stat-best').textContent = best.join(' · ');

  $('stat-recent').replaceChildren(...s.recent.map(recentItem));
}

function tile(value: string, label: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'stat-tile';
  const b = document.createElement('b');
  b.textContent = value;
  const span = document.createElement('span');
  span.textContent = label;
  el.append(b, span);
  return el;
}

/** One row per opponent that has been played; the table hides itself when there are none. */
function table(el: HTMLElement, head: string[], rows: Stats['matches'], cells: (r: Tally) => (string | number)[]): void {
  const played = OPPONENTS.filter((o) => rows[o].played > 0);
  el.classList.toggle('hidden', played.length === 0);
  (el.previousElementSibling as HTMLElement).classList.toggle('hidden', played.length === 0);
  const tr = (tag: 'th' | 'td', values: (string | number)[]) => {
    const row = document.createElement('tr');
    for (const v of values) {
      const cell = document.createElement(tag);
      cell.textContent = String(v);
      row.append(cell);
    }
    return row;
  };
  el.replaceChildren(tr('th', head), ...played.map((o) => tr('td', [OPPONENT_LABEL[o], ...cells(rows[o])])));
}

function recentItem(r: RecentResult): HTMLElement {
  const li = document.createElement('li');
  const chip = document.createElement('span');
  chip.className = `chip ${r.result}`;
  chip.textContent = r.result;
  const line = document.createElement('span');
  line.className = 'line';
  line.textContent = `${r.us} ${r.score[0]}–${r.score[1]} ${r.them}`;
  const meta = document.createElement('small');
  meta.textContent = `${OPPONENT_LABEL[r.opponent]} · ${r.mode === 'penalties' ? 'Shootout' : 'Match'} · ${ago(r.at)}`;
  line.append(meta);
  li.append(chip, line);
  return li;
}

function ago(at: number): string {
  const mins = Math.round((Date.now() - at) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}
