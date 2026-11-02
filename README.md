# Rooftop Rush

3v3 cage football on a city rooftop, in the browser. Play against bots, or **online with up to 6 people** (3 a side): each person controls one player and bots fill any empty spots. The game server runs the match; browsers only send their inputs.

## Run it

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm run dev
```

`npm run dev` starts two things side by side: the **game server** (port 2567) and the **game page** (port 5173). Open http://localhost:5173.

**Try online play on one computer:** open http://localhost:5173 in two tabs. In the first, pick *Play online → Create private room*. In the second, pick *Play online* and type the 4-letter code. The first tab is the host and presses **Start match**.

**Online rooms:** up to 3 people a side, bots on any empty spots. In the lobby you can switch teams (*Join this team*), and each team is named after its first person. The host starts a private room; quick match starts by itself a few seconds after both teams have someone (straight away when full). Friends can join a match that's already under way (they take over a bot), and if someone leaves, a bot takes over their player. After full time everyone goes back to the lobby together. Players controlled by other people have a thin white ring.

**Test a bad connection on your own machine:** add `?lag=200&jitter=40` to the address (200 ms round trip, plus up to 40 ms of random extra delay). Add `&debug` to see a red ring where the server last confirmed your player, and how many of your inputs are still unconfirmed.

**With a friend on the same Wi-Fi:** the terminal shows a `Network:` address like `http://192.168.1.20:5173`. They open that on their phone or laptop and join with your code. (If it can't connect, your firewall may be blocking port 2567.)

| Command | What it does |
|---|---|
| `npm run dev` | Starts the game server and the game page with live reload |
| `npm run server` | Starts only the game server |
| `npm run client` | Starts only the game page |
| `npm test` | Runs the automated tests (physics, rules, bots) |
| `npm run typecheck` | Checks the TypeScript for errors |
| `npm run build` | Builds the final site into `dist/` (upload this folder to any static host) |
| `npx tsx scripts/botmatch.ts 20 normal` | Plays 20 bot-vs-bot matches without graphics and prints stats (good for balancing) |
| `npx tsx scripts/penalties.ts 60 normal` | Plays 60 bot-vs-bot shootouts and prints how often penalties go in |

## Controls

**On a phone or tablet** the game shows on-screen controls automatically: drag anywhere on the left half to move (push to the edge to sprint). The four buttons on the right change job with the situation, like FC Mobile and eFootball:

| Situation | Buttons |
|---|---|
| Your team has the ball | **SHOOT** (hold) · PASS · THROUGH · SKILL |
| The other team has it | **TACKLE** · SWITCH · PRESS (hold to chase) · SPRINT |
| Penalties, your kick | **SHOOT** (aim with the stick first) |
| Penalties, in goal | **DIVE** (the way the stick is pushed) |

Several fingers work at once. Landscape is recommended; the game suggests turning the phone and, where the browser allows, goes fullscreen.


| Action | Keyboard | Gamepad |
|---|---|---|
| Move | WASD / arrows | Left stick |
| Sprint | Shift | RT |
| Shoot (hold to charge) | J / Space | X |
| Curl a shot | Steer sideways while charging | — |
| Pass | K | A |
| Through ball (into space ahead of a teammate) | I | Y |
| Press: hold to chase the ball | E | LT |
| Tackle (not from behind) | L | B |
| Skill move: sidestep, or pull back to drag it back and turn | O | RB |
| Head or volley a ball in the air (hold as a cross comes in) | J / Space | X |
| Head it to a teammate | K | A |
| Switch player (to the teammate with the **Q** badge) | Q | LB |
| Pause / sound | Esc / M | Start |

**Skill moves:** with the ball, SKILL (O / RB) does a quick sidestep the way you push (or away from the nearest defender), or, pulling the stick back, a drag-back that turns you round. For a moment afterwards tackles miss, and a defender who lunges at it is left off balance. Each one costs a little stamina and needs a second to recharge.

**Headers, volleys and crosses:** a pass from out wide near goal to a teammate in the box is a **cross**, lofted to drop at head height. When the ball is at head height near you, SHOOT heads it where you're pointing (or hold SHOOT as it arrives) and PASS heads it to a teammate. A first-time shot on a ball in the air is a **volley**: flatter and quicker. Goals from them are announced as HEADER! and VOLLEY!

Passes and tackles fill your **Rush** meter. When it's full, your next shot is a power shot.

**Team name:** type your team's name on the main menu (up to 14 letters, numbers or spaces). It's remembered on this device. Online, both players see each other's names; the server tidies them up first, and two identical names are told apart.

**Sound:** ♪ turns all sound on or off (or press M), ♫ turns the background music on or off. The music is generated live in the browser, so there are no audio files and nothing to license.

**Training:** three drills of ten balls on an empty pitch, each with your best score saved. *Curl*: shoot from a spot outside the box past two defenders into a gold ring low in either corner; aim outside a defender and flick sideways as you let go to bend it in. *Power*: full-strength shots against a hard bot keeper, with each shot's speed shown. *Through balls*: your teammate runs past two defenders; time a through ball into the glowing zone ahead of them (too early is cut out, too late runs out). You can turn but not move until you strike the ball.

**Game modes:** pick **Match** (3 minutes, 3v3) or **Penalties** on the menu; both work against bots and online. Quick match only pairs players who picked the same mode; a room code plays whatever its creator picked.

**Penalties:** 5 kicks each, alternating, ending early once one side can't catch up, then sudden death. The camera moves behind the taker, looking at the goal, and the controls follow it (right on screen is always right). Taking: aim left/right (a yellow line shows where), hold shoot for power; steer sideways while charging to curl it. In goal: move left/right along the line, then tackle/DIVE dives the way you're pushing (no direction = spring up). Bot keepers shuffle along the line and lean toward where you're aiming (harder keepers read it better), then guess or react as you shoot. You'll score about 3 in 4 on Easy and 2 in 3 on Normal.

**Kickoffs:** the kicker starts with the ball and must pass to a teammate first. You can turn on the spot to aim, but not dribble or shoot, and the other team must stay outside the centre circle until the pass. If nobody passes within 6 seconds, the pass is made for you.

**Switching:** you automatically take over the player who receives your pass or wins the ball. When defending, you're also switched to a teammate who is much closer to the ball (at most once every 0.75 s, so it never fights a manual switch). The **Q** badge shows who pressing Q would give you.

## How the code is organised

```
shared/            Runs the same in the browser and on the server. No graphics, no clock, no Math.random.
  constants.ts     Every tunable number: speeds, shot power, pitch size, match length. Balance the game here.
  types.ts         The shape of the game state: World, Player, Ball, Input, events.
  sim.ts           The match itself: step(world, inputs) advances it by one 1/60 s tick.
  bot.ts           Bot brains. They return the same Input a human would.
  math.ts          Small helpers (angles, seeded random numbers).
  protocol.ts      Online messages, snapshots, and the checks that reject bad client messages.
  prediction.ts    Client prediction and reconciliation for your own player online.
  control.ts       Which player each person controls (several per team; auto-switch never takes a teammate's player).
  interp.ts        Adaptive smoothing buffer for online play.
  names.ts         Cleaning and pairing team names.
  kits.ts          Shirt colours, and picking two that don't clash.
  chat.ts          The quick-chat messages (a fixed list, nothing typed).
server/            Node.js only.
  server.ts        WebSocket server: quick match, room codes, rate limiting.
  room.ts          One room: lobby (teams, host), then the match at 60 ticks/s with 60 snapshots a second.
  main.ts          Starts the server on PORT (default 2567).
client/            Browser only.
  main.ts          Menus, lobby, and switching between local and online play.
  game.ts          Local match loop: read input → ask bots → step the sim.
  online.ts        Online match: send inputs, receive snapshots, blend between them.
  net.ts           WebSocket connection, server address, and the ?lag= simulator.
  effects.ts       Match events → sounds, screen shake, messages.
  crowd.ts         When the crowd reacts: shots on target, near misses, attacks, last 30 s, full time.
  haptics.ts       Phone vibration for shots, tackles and goals.
  replay.ts        Instant replay: keeps the last few seconds and replays goals in slow motion.
  stats.ts         Your record (results, goals, penalties, streaks), saved in this browser.
  stats-view.ts    The "Your stats" screen.
  tournament.ts    Knockout tournament vs bots: draw, bracket, bot results, saving.
  tournament-view.ts  The bracket.
  training.ts      Training drills (curl, power, through balls): setting up and judging each ball.
  training-game.ts Runs a drill: ten balls, the HUD bar, best scores.
  renderer.ts      Three.js drawing: arena, city, players, ball, camera, effects.
  input.ts         Keyboard, gamepad and touch → Input.
  touch.ts         On-screen joystick and buttons for phones (multi-touch).
  joystick.ts      Joystick maths (dead zone, push-to-sprint), kept DOM-free for testing.
  audio.ts         Sound effects, generated in code (no audio files).
  music.ts         Soft background music, generated live (chords, bass, arpeggio).
  settings.ts      Remembers team name, sound and music choices on this device.
  hud.ts           Score, clock, Rush and power meters.
tests/             Automated tests: rules, protocol, and the real server with test clients.
scripts/botmatch.ts  Headless bot matches for balancing.
scripts/make-icons.ts  Draws the app icons into public/icons/.
public/            Copied as-is into the build: app manifest, service worker (offline play), icons.
```

### Key ideas worth understanding

- **Fixed timestep.** The simulation always moves in steps of exactly 1/60 s, whatever your screen's frame rate. `client/game.ts` keeps an accumulator and runs as many steps as are due each frame.
- **Interpolation.** The renderer blends between the previous and current tick (`takeSnapshot` + `alpha`), so motion is smooth on 120 Hz screens too. The same trick is used later to smooth other players over the network.
- **Inputs, not positions.** Humans and bots both produce an `Input` (move, sprint, shoot, pass, tackle). The simulation is the only thing that changes the world. That's what makes server-authoritative multiplayer possible.
- **Determinism.** Same starting state + same inputs = same result (there's a test for this). Bots use a seeded random generator for the same reason.
- **Events.** `step()` fills `world.events` (goal, shot, tackle, save…) and the client turns those into sound, screen shake and messages. Online, the server sends the same events to both players inside each snapshot.

### How online play works

1. Each browser reads your keys 60 times a second and sends them as tiny messages: `{"t":"input","seq":42,"i":[0.71,-0.71,3]}` (move x, move z, buttons as bits).
2. The server queues each player's inputs and uses one per tick. If one arrives late, it keeps you moving the same way but doesn't repeat button taps.
3. Every tick (60 times a second) it sends everyone a **snapshot**: every player's position, the ball, score, clock, who controls which player, and any events. `ack` tells you which of your inputs it has used.
4. Other players and the ball are drawn slightly in the past, **blending between the two snapshots** either side of that moment. The buffer adapts to the connection (`shared/interp.ts`): about 40 ms on a steady line, more when snapshots arrive unevenly. Snapshots arrive 60 times a second.
5. **Your own player is predicted** (`shared/prediction.ts`), so it responds instantly instead of after a full round trip:
   - Every input you send is also applied straight away in your browser, using the same `moveWithInput` function the server uses.
   - Each snapshot says which of your inputs the server has used (`ack`). The browser starts again from the server's position and re-applies only the inputs it hasn't seen yet. This is **reconciliation**.
   - If the server disagrees (someone bumped you), the difference fades out over a few frames instead of making you jump. Big differences, like a kickoff reset, jump straight there.
6. If inputs pile up after a network hiccup, the server skips ahead (keeping button taps) so you don't stay behind.
7. The server checks every message (`parseClientMessage`) and limits how many each client may send. A client can't move faster, teleport, or control someone else's player.

6. **Your own shots and passes are predicted too** (`KickPredictor`): the kick runs on a copy of the latest snapshot, so the ball leaves your foot immediately and flies with the same physics. If someone else touches it, it glides over to the server's ball.

**What isn't predicted:** tackles, other people's actions, and the keeper during penalties. Those arrive after your ping (about 185 ms from the Gulf to Render's Frankfurt servers) plus the small smoothing buffer.

## Deploying (free)

The whole game runs as **one Render web service**: the Node server serves the built page *and* the multiplayer connection from the same address, so there's nothing to configure. `render.yaml` holds the settings.

1. **Put the code on GitHub.** Create an empty repository at https://github.com/new (private is fine; don't add a README), then:
   ```bash
   git remote add origin https://github.com/YOUR-NAME/rooftop-rush.git
   git push -u origin main
   ```
2. **Create the service on Render.** Sign up at https://render.com (free, no card needed for the free plan), choose **New → Blueprint**, connect GitHub, and pick the `rooftop-rush` repository. Render reads `render.yaml` and starts building. The first build takes a few minutes. The server runs in Render's **Frankfurt** region (set in `render.yaml`), the closest to the Middle East; pick the region nearest your players.
3. **Play.** Render gives you an address like `https://rooftop-rush-xxxx.onrender.com`. Open it, choose *Play online → Create private room*, and send your friend the address and code.
4. **Updates deploy themselves:** every `git push` to `main` rebuilds and redeploys.

**Check it's healthy:** `https://your-address.onrender.com/health` should show `{"ok":true,...}`.

**About the free plan:** the service goes to sleep after about 15 minutes with no visitors. The next visitor waits up to a minute while it wakes up, and any match in progress when it sleeps is lost (it only sleeps when nobody is connected). Upgrading the plan, or moving the server to an always-on machine like Oracle Cloud's free tier, removes the wait.

**Hosting the page somewhere else** (e.g. GitHub Pages or Cloudflare Pages): build with `VITE_SERVER_URL=wss://your-server.onrender.com npm run build` and upload `dist/`.

**Run the production version locally** to check it before pushing:
```bash
npm run build
PORT=3000 npm start
```
Then open http://localhost:3000.

## Next milestones

1. ~~Local match against bots~~ ✅
2. ~~Online 1v1: server runs the match, quick match, room codes, rematch~~ ✅ (now up to 3v3, see 4)
3. ~~Responsive online play: client prediction and reconciliation~~ ✅
4. ~~3v3 online: lobby, teams, host start, join mid-match, bots fill empty spots~~ ✅
5. ~~Touch controls for phones and tablets~~ ✅
6. ~~Deploy setup: one Render service for page and server~~ ✅
7. ~~Goal celebrations and instant replays (local and online)~~ ✅
8. ~~Your stats, saved in the browser (accounts can sync them later)~~ ✅
9. ~~Kit colours, invite links, crowd reactions~~ ✅
10. ~~Install as an app (works offline vs bots), phone vibration, quick chat~~ ✅
11. ~~Tournament: 8-team knockout vs bots, penalties after a draw, saved progress~~ ✅
12. ~~Skill moves, headers, volleys and crosses~~ ✅
13. ~~Training: curl, power and through-ball drills with best scores~~ ✅
14. Accounts and leaderboard with Supabase.
