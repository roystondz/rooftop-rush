# Rooftop Rush

3v3 cage football on a city rooftop, in the browser. Play against bots, or **online 1v1**: each person controls one player and bots fill the other spots. The game server runs the match; browsers only send their inputs.

## Run it

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm run dev
```

`npm run dev` starts two things side by side: the **game server** (port 2567) and the **game page** (port 5173). Open http://localhost:5173.

**Try online play on one computer:** open http://localhost:5173 in two tabs. In the first, pick *Play online → Create private room*. In the second, pick *Play online* and type the 4-letter code.

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

## Controls

**On a phone or tablet** the game shows on-screen controls automatically: drag anywhere on the left half to move (push to the edge to sprint), and use the SHOOT (hold), PASS, TACKLE, SPRINT and Q buttons on the right. Several fingers work at once. Landscape is recommended; the game suggests turning the phone and, where the browser allows, goes fullscreen.


| Action | Keyboard | Gamepad |
|---|---|---|
| Move | WASD / arrows | Left stick |
| Sprint | Shift | RT / RB |
| Shoot (hold to charge) | J / Space | X |
| Curl a shot | Steer sideways while charging | — |
| Pass | K | A |
| Tackle (not from behind) | L | B |
| Switch player (to the teammate with the **Q** badge) | Q | LB |
| Pause / sound | Esc / M | Start |

Passes and tackles fill your **Rush** meter. When it's full, your next shot is a power shot.

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
  control.ts       Which player each human controls (auto-switch on pass and possession).
server/            Node.js only.
  server.ts        WebSocket server: quick match, room codes, rate limiting.
  room.ts          One match: runs the sim at 60 ticks/s, sends snapshots 30 times a second.
  main.ts          Starts the server on PORT (default 2567).
client/            Browser only.
  main.ts          Menus, lobby, and switching between local and online play.
  game.ts          Local match loop: read input → ask bots → step the sim.
  online.ts        Online match: send inputs, receive snapshots, blend between them.
  net.ts           WebSocket connection, server address, and the ?lag= simulator.
  effects.ts       Match events → sounds, screen shake, messages.
  renderer.ts      Three.js drawing: arena, city, players, ball, camera, effects.
  input.ts         Keyboard, gamepad and touch → Input.
  touch.ts         On-screen joystick and buttons for phones (multi-touch).
  joystick.ts      Joystick maths (dead zone, push-to-sprint), kept DOM-free for testing.
  audio.ts         Sounds, generated in code (no audio files).
  hud.ts           Score, clock, Rush and power meters.
tests/             Automated tests: rules, protocol, and the real server with test clients.
scripts/botmatch.ts  Headless bot matches for balancing.
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
3. Every 2 ticks (30 times a second) it sends both players a **snapshot**: every player's position, the ball, score, clock and any events. `ack` tells you which of your inputs it has used.
4. Other players and the ball are drawn about 100 ms in the past, **blending between the two snapshots** either side of that moment, so they move smoothly even though updates only arrive 30 times a second.
5. **Your own player is predicted** (`shared/prediction.ts`), so it responds instantly instead of after a full round trip:
   - Every input you send is also applied straight away in your browser, using the same `moveWithInput` function the server uses.
   - Each snapshot says which of your inputs the server has used (`ack`). The browser starts again from the server's position and re-applies only the inputs it hasn't seen yet. This is **reconciliation**.
   - If the server disagrees (someone bumped you), the difference fades out over a few frames instead of making you jump. Big differences, like a kickoff reset, jump straight there.
6. If inputs pile up after a network hiccup, the server skips ahead (keeping button taps) so you don't stay behind.
7. The server checks every message (`parseClientMessage`) and limits how many each client may send. A client can't move faster, teleport, or control someone else's player.

**What isn't predicted:** passes, shots and tackles still wait for the server, because they involve other players and the ball. With a 250 ms ping, your movement responds in about 2 frames, and a shot leaves your foot after about a quarter of a second.

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
2. ~~Online 1v1: server runs the match, quick match, room codes, rematch~~ ✅
3. ~~Responsive online play: client prediction and reconciliation~~ ✅
4. 3v3 online, bots filling empty spots, quick match.
5. ~~Touch controls for phones and tablets~~ ✅
6. ~~Deploy setup: one Render service for page and server~~ ✅
7. Accounts and leaderboard with Supabase.
