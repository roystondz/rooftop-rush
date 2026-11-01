// Bot-vs-bot penalty shootouts, to check how often penalties go in. Run: npx tsx scripts/penalties.ts [shootouts] [difficulty]
import { Bot, BOT_SKILLS, type Difficulty } from '../shared/bot';
import { createWorld, step } from '../shared/sim';

const runs = Number(process.argv[2] ?? 40);
const skill = BOT_SKILLS[(process.argv[3] ?? 'normal') as Difficulty];
let kicks = 0;
let scored = 0;
let sudden = 0;
const wins = [0, 0];
for (let r = 0; r < runs; r++) {
  const w = createWorld({ mode: 'penalties' });
  const bots = w.players.map((p) => new Bot(p.id, skill, r));
  let ticks = 0;
  while (w.phase !== 'fulltime' && ticks < 60 * 60 * 10) {
    step(w, bots.map((b) => b.think(w)));
    ticks++;
  }
  const [a, b] = w.shootout!.kicks;
  kicks += a.length + b.length;
  scored += [...a, ...b].reduce((n, k) => n + k, 0);
  if (a.length > 5) sudden++;
  if (w.winner >= 0) wins[w.winner]++;
}
console.log(`scored ${((scored / kicks) * 100).toFixed(0)}% of ${kicks} kicks · sudden death in ${sudden}/${runs} · wins ${wins.join('-')}`);
