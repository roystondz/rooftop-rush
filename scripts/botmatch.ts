// Plays full bot-vs-bot matches without graphics and prints stats. Run: npx tsx scripts/botmatch.ts [matches] [difficulty]
import { Bot, BOT_SKILLS, type Difficulty } from '../shared/bot';
import { createWorld, step } from '../shared/sim';

const matches = Number(process.argv[2] ?? 20);
const skill = BOT_SKILLS[(process.argv[3] ?? 'normal') as Difficulty];
const totals: Record<string, number> = {};
let goals = [0, 0];
let golden = 0;
for (let m = 0; m < matches; m++) {
  const w = createWorld();
  const bots = w.players.map((p) => new Bot(p.id, skill, m));
  let ticks = 0;
  while (w.phase !== 'fulltime' && ticks < 60 * 60 * 6) {
    step(w, bots.map((b) => b.think(w)));
    for (const e of w.events) {
      totals[e.type] = (totals[e.type] ?? 0) + 1;
      if (e.type === 'shot' || e.type === 'powerShot') totals['shotsT' + e.team] = (totals['shotsT' + e.team] ?? 0) + 1;
    }
    ticks++;
    const b = w.ball;
    if (![b.x, b.y, b.z].every(Number.isFinite)) throw new Error('NaN ball at tick ' + ticks);
  }
  goals[0] += w.score[0];
  goals[1] += w.score[1];
  if (w.goldenGoal) golden++;
}
console.log(`goals per match: ${((goals[0] + goals[1]) / matches).toFixed(1)}  team0=${goals[0]} team1=${goals[1]}  golden goals=${golden}`);
for (const k of Object.keys(totals).sort()) console.log(k.padEnd(12), (totals[k] / matches).toFixed(1));
