// Draws the tournament bracket. Team names can come from players, so they go in as text.
import { ROUND_NAMES, YOU, pairings, type Result, type Tournament } from './tournament';

const ROUND_SHORT = ['Quarter-finals', 'Semi-finals', 'Final'];

export function renderBracket(el: HTMLElement, t: Tournament): void {
  el.replaceChildren(
    ...ROUND_NAMES.map((_, round) => {
      const col = document.createElement('div');
      col.className = 'round';
      const h = document.createElement('h3');
      h.textContent = ROUND_SHORT[round];
      const matches = document.createElement('div');
      matches.className = 'matches';
      const pairs = pairings(t, round);
      const count = [4, 2, 1][round];
      for (let i = 0; i < count; i++) {
        const pair = pairs?.[i] ?? null;
        const result = pair ? t.rounds[round].find((r) => r.a === pair[0] && r.b === pair[1]) : undefined;
        matches.append(matchCard(t, pair, result));
      }
      col.append(h, matches);
      return col;
    }),
  );
}

function matchCard(t: Tournament, pair: [number, number] | null, r: Result | undefined): HTMLElement {
  const card = document.createElement('div');
  card.className = 'match';
  if (pair?.includes(YOU) && !r) card.classList.add('next');
  const side = (i: 0 | 1) => {
    const row = document.createElement('div');
    row.className = 'side';
    const who = pair ? pair[i] : -1;
    if (who === YOU) row.classList.add('you');
    if (r) row.classList.add(r.winner === who ? 'won' : 'lost');
    const name = document.createElement('span');
    name.textContent = who >= 0 ? t.entrants[who].name : '—';
    const score = document.createElement('b');
    if (r) score.textContent = r.pens ? `${r.score[i]} (${r.pens[i]})` : String(r.score[i]);
    row.append(name, score);
    return row;
  };
  card.append(side(0), side(1));
  return card;
}
