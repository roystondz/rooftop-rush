import './style.css';
import type { Difficulty } from '../shared/bot';
import type { World } from '../shared/types';
import { Sfx } from './audio';
import { Effects } from './effects';
import { Game } from './game';
import { Hud, TEAM_NAMES } from './hud';
import { InputManager } from './input';
import { isTouchDevice } from './joystick';
import { Connection, lagFromUrl, serverUrl } from './net';
import { OnlineGame } from './online';
import { Renderer } from './renderer';
import { TouchControls } from './touch';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const sfx = new Sfx();
const touchDevice = isTouchDevice();
document.documentElement.classList.toggle('touch', touchDevice);
const renderer = new Renderer($<HTMLCanvasElement>('game'), touchDevice);
const hud = new Hud();
const input = new InputManager();
const effects = new Effects(sfx, renderer, hud);
const touch = touchDevice ? new TouchControls() : null;
input.touch = touch;
if (touch) effects.passHint = 'tap PASS';
const game = new Game(renderer, hud, input, effects);
let online: OnlineGame | null = null;
let mode: 'menu' | 'local' | 'online' = 'menu';
let difficulty: Difficulty = 'normal';
// Testing aids: ?lag=200&jitter=40 fakes a slow connection, ?debug shows prediction details.
const lag = lagFromUrl();
const debugNet = new URLSearchParams(location.search).has('debug');

const screens = ['menu', 'online', 'waiting', 'pause', 'fulltime'] as const;
type Screen = (typeof screens)[number];
function show(screen: Screen | null): void {
  for (const s of screens) $(s).classList.toggle('hidden', s !== screen);
}

function setStatus(text: string, isError = false): void {
  const el = $('online-status');
  el.textContent = text;
  el.classList.toggle('error', isError);
}

// --- one animation loop drives whichever mode is active ---------------------------

let lastFrame = 0;
function loop(now: number): void {
  const dt = lastFrame ? Math.min(0.1, (now - lastFrame) / 1000) : 0;
  lastFrame = now;
  if (mode === 'local') game.frame(dt);
  else if (online) online.frame(dt);
  syncTouchControls();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// --- local play -------------------------------------------------------------------

/** On-screen controls appear only while a match is being played, not over menus. */
function syncTouchControls(): void {
  const inMatch =
    (mode === 'local' && game.world !== null) || (mode === 'online' && online?.started === true);
  const menuOpen = ['pause', 'fulltime', 'waiting', 'online', 'menu'].some((id) => !$(id).classList.contains('hidden'));
  document.documentElement.classList.toggle('in-match', inMatch && !menuOpen);
  touch?.show(inMatch && !menuOpen);
}

/** On phones, use the whole screen and prefer landscape where the browser allows it. */
function enterFullscreen(): void {
  if (!touchDevice || document.fullscreenElement) return;
  const el = document.documentElement;
  el.requestFullscreen?.()
    .then(() => (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape'))
    .catch(() => {
      // Not allowed here (e.g. iPhone Safari): play in the normal window instead.
    });
}

function playLocal(): void {
  sfx.unlock();
  enterFullscreen();
  leaveOnline();
  mode = 'local';
  show(null);
  game.start(difficulty);
}

function toMenu(): void {
  game.stop();
  leaveOnline();
  hud.hide();
  mode = 'menu';
  show('menu');
}

function setPaused(paused: boolean): void {
  if (mode === 'local') {
    if (!game.world || game.world.phase === 'fulltime') return;
    game.paused = paused;
  } else if (mode !== 'online' || !online?.started) {
    return;
  }
  // Online matches can't pause (the other player is still playing), so this is just a menu.
  $('pause-title').textContent = mode === 'online' ? 'Menu' : 'Paused';
  show(paused ? 'pause' : null);
}

function showResult(w: World, myTeam: 0 | 1): void {
  const [a, b] = w.score;
  $('result-title').textContent = w.winner === myTeam ? 'You win!' : w.winner === -1 ? 'Draw' : 'You lose';
  $('result-score').textContent = `${TEAM_NAMES[0]} ${a} – ${b} ${TEAM_NAMES[1]}`;
  $('again').textContent = mode === 'online' ? 'Rematch' : 'Play again';
  $('rematch-status').textContent = '';
  show('fulltime');
}

effects.onFullTime = (w) => {
  if (mode === 'local') showResult(w, game.humanTeam);
  else if (mode === 'online' && online) showResult(w, online.team);
};

// --- online play ------------------------------------------------------------------

function leaveOnline(): void {
  online?.leave();
  online = null;
}

async function goOnline(first: 'quick' | 'create' | { join: string }): Promise<void> {
  sfx.unlock();
  enterFullscreen();
  leaveOnline();
  setStatus('Connecting…');
  let conn: Connection;
  try {
    conn = await Connection.open(serverUrl(), lag);
  } catch {
    setStatus("Can't reach the game server. Is it running? (npm run server)", true);
    return;
  }
  mode = 'online';
  online = new OnlineGame(conn, renderer, hud, input, effects, debugNet, {
    room(code, isPublic) {
      $('room-code').textContent = code;
      $('code-box').classList.toggle('hidden', isPublic);
      $('waiting-title').textContent = isPublic ? 'Finding an opponent…' : 'Waiting for your friend…';
      show('waiting');
    },
    start(team) {
      show(null);
      hud.message(`YOU ARE ${TEAM_NAMES[team]}`, team === 0 ? 'Attack to the right →' : '← Attack to the left', 2);
    },
    rematchRequested(team) {
      if (team !== online?.team) $('rematch-status').textContent = 'Your opponent wants a rematch!';
    },
    opponentLeft() {
      $('result-title').textContent = 'Opponent left';
      $('result-score').textContent = '';
      $('rematch-status').textContent = '';
      $('again').textContent = 'Find another match';
      hud.hide();
      show('fulltime');
      leaveOnline();
    },
    error(message) {
      setStatus(message, true);
      leaveOnline();
      mode = 'menu';
      show('online');
    },
    disconnected() {
      setStatus('Lost connection to the server.', true);
      online = null;
      hud.hide();
      mode = 'menu';
      show('online');
    },
  });
  if (first === 'quick') conn.send({ t: 'quick' });
  else if (first === 'create') conn.send({ t: 'create' });
  else conn.send({ t: 'join', code: first.join });
  setStatus('');
}

// --- buttons and keys -------------------------------------------------------------

document.querySelectorAll<HTMLButtonElement>('[data-difficulty]').forEach((btn) => {
  btn.addEventListener('click', () => {
    difficulty = btn.dataset.difficulty as Difficulty;
    document.querySelectorAll('[data-difficulty]').forEach((b) => b.classList.toggle('selected', b === btn));
  });
});

$('play').addEventListener('click', playLocal);
$('rotate-ok').addEventListener('click', () => document.documentElement.classList.add('rotate-ok'));
$('online-btn').addEventListener('click', () => {
  setStatus('');
  show('online');
});
$('online-back').addEventListener('click', () => show('menu'));
$('quick').addEventListener('click', () => void goOnline('quick'));
$('create').addEventListener('click', () => void goOnline('create'));
$('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $<HTMLInputElement>('code-input').value.trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(code)) {
    setStatus('Room codes are 4 letters.', true);
    return;
  }
  void goOnline({ join: code });
});
$('cancel-wait').addEventListener('click', () => {
  leaveOnline();
  mode = 'menu';
  show('online');
});
$('copy-code').addEventListener('click', () => {
  void navigator.clipboard?.writeText($('room-code').textContent ?? '');
  $('copy-code').textContent = 'Copied!';
  setTimeout(() => ($('copy-code').textContent = 'Copy code'), 1200);
});

$('again').addEventListener('click', () => {
  if (mode === 'online' && online) {
    online.rematch();
    $('rematch-status').textContent = 'Waiting for your opponent…';
  } else if (mode === 'online' || $('again').textContent === 'Find another match') {
    void goOnline('quick');
  } else {
    playLocal();
  }
});
$('to-menu').addEventListener('click', toMenu);
$('quit').addEventListener('click', toMenu);
$('resume').addEventListener('click', () => setPaused(false));
$('pause-btn').addEventListener('click', () => setPaused($('pause').classList.contains('hidden')));
$('mute-btn').addEventListener('click', toggleMute);

function toggleMute(): void {
  sfx.setMuted(!sfx.muted);
  $('mute-btn').classList.toggle('muted', sfx.muted);
}

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return; // typing a room code
  if (e.code === 'Escape' || e.code === 'KeyP') setPaused($('pause').classList.contains('hidden'));
  if (e.code === 'KeyM') toggleMute();
  if (e.code === 'Enter' && mode === 'menu' && !$('menu').classList.contains('hidden')) playLocal();
});

// A hidden tab stops drawing, so pause local games. Online matches keep running on the server.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && mode === 'local') setPaused(true);
});

if (import.meta.env.DEV) {
  // Handy for poking at the game from the browser console.
  Object.assign(window, { __rr: { game, get online() { return online; }, get mode() { return mode; } } });
}
