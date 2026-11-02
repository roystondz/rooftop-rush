import './style.css';
import type { Difficulty } from '../shared/bot';
import { DEFAULT_KITS, KITS, kitCss, teamKits } from '../shared/kits';
import { DEFAULT_TEAM_NAMES, MAX_TEAM_NAME, teamNames } from '../shared/names';
import type { World } from '../shared/types';
import { Sfx } from './audio';
import { Effects } from './effects';
import { Game } from './game';
import { Hud } from './hud';
import { InputManager } from './input';
import { isTouchDevice } from './joystick';
import { Connection, inviteLink, lagFromUrl, roomFromUrl, serverUrl } from './net';
import { MAX_PER_TEAM, type LobbyInfo } from '../shared/protocol';
import { OnlineGame } from './online';
import { Renderer } from './renderer';
import { loadSettings, saveSettings } from './settings';
import { clearStats, loadStats, recordEvent, recordResult, saveStats, type Opponent } from './stats';
import { renderStats } from './stats-view';
import { TouchControls, type TouchMode } from './touch';
import type { GameMode, Team } from '../shared/types';
import { penaltyDuel } from '../shared/sim';

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
if (touch) {
  effects.passHint = 'tap PASS';
  hud.skipHint = 'Tap any button to skip';
  effects.penaltyHints = { take: 'aim with the stick, hold SHOOT', save: 'stick to move, DIVE' };
}
const game = new Game(renderer, hud, input, effects);
let online: OnlineGame | null = null;
let mode: 'menu' | 'local' | 'online' = 'menu';
let difficulty: Difficulty = 'normal';
let gameMode: GameMode = 'match';
const settings = loadSettings();
let stats = loadStats();
/** Who the current match is against, for your stats. */
let opponent: Opponent = 'normal';
/** Names shown for the current match: [left team, right team]. */
let names: [string, string] = [...DEFAULT_TEAM_NAMES];
// Testing aids: ?lag=200&jitter=40 fakes a slow connection, ?debug shows prediction details.
const lag = lagFromUrl();
const debugNet = new URLSearchParams(location.search).has('debug');

const screens = ['menu', 'online', 'lobby', 'pause', 'fulltime', 'stats'] as const;
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
  const menuOpen = ['pause', 'fulltime', 'lobby', 'online', 'menu', 'stats'].some((id) => !$(id).classList.contains('hidden'));
  document.documentElement.classList.toggle('in-match', inMatch && !menuOpen);
  touch?.show(inMatch && !menuOpen);
  if (touch && inMatch) {
    const w = mode === 'local' ? game.world : online?.world;
    const myTeam: Team = mode === 'local' ? game.humanTeam : (online?.team ?? 0);
    if (w) touch.setMode(touchModeFor(w, myTeam, touch.mode));
  }
}

/** Attack buttons while your team has the ball, defence buttons while the other team does. */
function touchModeFor(w: World, myTeam: Team, current: TouchMode): TouchMode {
  const duel = penaltyDuel(w);
  if (duel) return duel.taker.team === myTeam ? 'penaltyTaker' : 'penaltyKeeper';
  const owner = w.ball.owner >= 0 ? w.players[w.ball.owner] : undefined;
  if (!owner) return current === 'idle' ? 'attack' : current; // loose ball: keep what you had
  return owner.team === myTeam ? 'attack' : 'defend';
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

/** Team names and kits for the match about to be played (call before the match starts). */
function useTeams(next: [string, string], kits: readonly [number, number] = DEFAULT_KITS): void {
  names = next;
  hud.setTeamNames(names);
  effects.names = names;
  effects.kits = [kits[0], kits[1]];
  renderer.setKits(kits);
  showKitColours(kits);
}

/** Scoreboard and lobby use the kit colours too. */
function showKitColours(kits: readonly [number, number]): void {
  const root = document.documentElement.style;
  root.setProperty('--kit0', kitCss(kits[0]));
  root.setProperty('--kit1', kitCss(kits[1]));
}

function playLocal(): void {
  startAudio();
  enterFullscreen();
  leaveOnline();
  mode = 'local';
  show(null);
  useTeams(teamNames(settings.teamName, undefined), teamKits(settings.kit, undefined));
  opponent = difficulty;
  game.start(difficulty, gameMode);
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
  const onPens = w.mode === 'penalties' ? ' on penalties' : '';
  $('result-score').textContent = `${names[0]} ${a} – ${b} ${names[1]}`;
  if (onPens && w.winner !== -1) $('result-title').textContent += onPens;
  $('result-extra').textContent = streakLine();
  $('again').textContent = mode === 'online' ? 'Back to lobby' : 'Play again';
  $('rematch-status').textContent = '';
  show('fulltime');
}

/** Under the result: your win streak, if you're on one. */
function streakLine(): string {
  if (stats.streak < 2) return '';
  const best = stats.streak === stats.bestStreak ? ' · new best!' : '';
  return `${stats.streak} wins in a row${best}`;
}

// Keep your stats as events happen. They're saved at full time (and only then), so quitting
// halfway through a match leaves no half-finished result behind.
effects.onEvent = (w, e) => {
  const playing = mode === 'local' ? game.world !== null : mode === 'online' && online?.started === true;
  if (!playing) return;
  const myTeam: Team = mode === 'local' ? game.humanTeam : (online?.team ?? 0);
  const controlled = mode === 'local' ? game.controlledId : (online?.controlledId ?? -1);
  if (e.type === 'fulltime') {
    recordResult(stats, w, myTeam, mode === 'online' ? 'online' : opponent, names);
    saveStats(stats);
  } else {
    recordEvent(stats, w, e, myTeam, controlled);
  }
};

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
  startAudio();
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
    lobby(info) {
      renderLobby(info);
      if (info.started) return; // someone joined or left mid-match: nothing to show
      // Back in the lobby (or just arrived). After full time, wait until they press "Back to lobby".
      if ($('fulltime').classList.contains('hidden')) show('lobby');
      else $('rematch-status').textContent = 'Everyone is back in the lobby.';
    },
    start(team, matchNames) {
      show(null);
      useTeams(matchNames, online?.kits);
      hud.message(`YOU ARE ${names[team]}`, team === 0 ? 'Attack to the right →' : '← Attack to the left', 2);
    },
    notice(text) {
      toast(text);
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
  // Send your chosen name; the server cleans it and tells both players the final names.
  const name = settings.teamName || undefined;
  const kit = settings.kit;
  // Joining with a code plays whatever the room was created for.
  if (first === 'quick') conn.send({ t: 'quick', name, kit, mode: gameMode });
  else if (first === 'create') conn.send({ t: 'create', name, kit, mode: gameMode });
  else conn.send({ t: 'join', code: first.join, name, kit });
  setStatus('');
}

// --- buttons and keys -------------------------------------------------------------

document.querySelectorAll<HTMLButtonElement>('[data-game-mode]').forEach((btn) => {
  btn.addEventListener('click', () => {
    gameMode = btn.dataset.gameMode as GameMode;
    document.querySelectorAll('[data-game-mode]').forEach((b) => b.classList.toggle('selected', b === btn));
  });
});

document.querySelectorAll<HTMLButtonElement>('[data-difficulty]').forEach((btn) => {
  btn.addEventListener('click', () => {
    difficulty = btn.dataset.difficulty as Difficulty;
    document.querySelectorAll('[data-difficulty]').forEach((b) => b.classList.toggle('selected', b === btn));
  });
});

$('play').addEventListener('click', playLocal);
$('stats-btn').addEventListener('click', () => {
  renderStats(stats);
  show('stats');
});
$('stats-back').addEventListener('click', () => show('menu'));
$('stats-reset').addEventListener('click', () => {
  if (!confirm('Clear all your stats on this device?')) return;
  stats = clearStats();
  renderStats(stats);
});
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
$('lobby-leave').addEventListener('click', () => {
  leaveOnline();
  mode = 'menu';
  show('online');
});
$('lobby-start').addEventListener('click', () => online?.requestStart());
document.querySelectorAll<HTMLButtonElement>('[data-join-team]').forEach((btn) => {
  btn.addEventListener('click', () => online?.chooseTeam(Number(btn.dataset.joinTeam) as Team));
});
// Invite: the phone's share sheet where there is one, otherwise copy the link.
$('copy-code').addEventListener('click', () => {
  const code = $('room-code').textContent ?? '';
  const url = inviteLink(code);
  const shared = 'share' in navigator && touchDevice
    ? navigator.share({ title: 'Rooftop Rush', text: `Join my Rooftop Rush room (${code})`, url })
    : navigator.clipboard?.writeText(url).then(() => {
        $('copy-code').textContent = 'Link copied!';
        setTimeout(() => ($('copy-code').textContent = 'Invite'), 1500);
      });
  // Sharing cancelled or clipboard blocked: the code is still on screen to read out.
  void shared?.catch(() => {});
});

// Opened from an invite link: offer to join that room with one tap.
const invited = roomFromUrl();
if (invited) {
  $('invite-code').textContent = invited;
  $('invite-card').classList.remove('hidden');
  $<HTMLInputElement>('code-input').value = invited;
  show('online');
}
$('invite-join').addEventListener('click', () => {
  if (!invited) return;
  $('invite-card').classList.add('hidden');
  history.replaceState(null, '', location.pathname); // so a refresh doesn't offer it again
  void goOnline({ join: invited });
});

$('again').addEventListener('click', () => {
  if (mode === 'online' && online) {
    // The server brings everyone back to the lobby a few seconds after full time.
    if (online.lobbyInfo && !online.lobbyInfo.started) show('lobby');
    else $('rematch-status').textContent = 'Back to the lobby in a moment…';
  } else if (mode === 'online') {
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
$('music-btn').addEventListener('click', toggleMusic);
$('music-toggle').addEventListener('click', () => {
  startAudio();
  toggleMusic();
});

// --- team name ----------------------------------------------------------------------

const nameInput = $<HTMLInputElement>('team-name');
nameInput.maxLength = MAX_TEAM_NAME;
nameInput.value = settings.teamName;
nameInput.addEventListener('input', () => {
  settings.teamName = nameInput.value;
  saveSettings(settings);
});
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') playLocal();
});

// --- kit -------------------------------------------------------------------------------

const kitPick = $('kit-pick');
KITS.forEach((kit, i) => {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('role', 'radio');
  btn.setAttribute('aria-label', kit.name);
  btn.title = kit.name;
  btn.style.setProperty('--kit', kitCss(i));
  btn.style.setProperty('--kit-shorts', `#${kit.shorts.toString(16).padStart(6, '0')}`);
  btn.addEventListener('click', () => {
    settings.kit = i;
    saveSettings(settings);
    showKitChoice();
  });
  kitPick.append(btn);
});

function showKitChoice(): void {
  [...kitPick.children].forEach((b, i) => {
    b.classList.toggle('selected', i === settings.kit);
    b.setAttribute('aria-checked', String(i === settings.kit));
  });
}
showKitChoice();

// --- sound and music ----------------------------------------------------------------

/** Browsers only allow sound after a click or tap, so audio starts with the first one. */
function startAudio(): void {
  sfx.unlock();
  sfx.setMusic(settings.music);
}

function toggleMute(): void {
  sfx.setMuted(!sfx.muted);
  settings.muted = sfx.muted;
  saveSettings(settings);
  showSoundState();
}

function toggleMusic(): void {
  settings.music = !settings.music;
  sfx.setMusic(settings.music);
  saveSettings(settings);
  showSoundState();
}

function showSoundState(): void {
  $('mute-btn').classList.toggle('muted', sfx.muted);
  $('music-btn').classList.toggle('off', !settings.music);
  $('music-toggle').classList.toggle('off', !settings.music);
  $('music-toggle').textContent = `Music: ${settings.music ? 'on' : 'off'}`;
}

sfx.setMuted(settings.muted);
showSoundState();
// The first click anywhere (e.g. on a menu button) starts the music, if it's switched on.
window.addEventListener('pointerdown', startAudio, { once: true });

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
  Object.assign(window, { __rr: { game, sfx, get online() { return online; }, get mode() { return mode; } } });
}

// --- lobby ---------------------------------------------------------------------------

let lobbyCountdownEnd: number | null = null;

/** Draws the lobby: both teams, who's in them, and what happens next. */
function renderLobby(info: LobbyInfo): void {
  $('room-code').textContent = info.code;
  showKitColours(info.kits);
  $('lobby-code-row').classList.toggle('hidden', info.isPublic);
  $('lobby-title').textContent = info.isPublic ? 'Quick match' : 'Your room';
  $('lobby-mode').textContent = info.mode === 'penalties' ? 'Penalty shootout' : 'Match · 3 minutes';
  const me = info.players.find((p) => p.seat === info.you);
  for (const team of [0, 1] as const) {
    $(`lobby-name-${team}`).textContent = info.names[team];
    const list = $(`lobby-list-${team}`);
    list.innerHTML = '';
    const people = info.players.filter((p) => p.team === team).sort((a, b) => a.seat - b.seat);
    for (const p of people) {
      const li = document.createElement('li');
      li.textContent = p.name;
      if (p.seat === info.host) li.append(tag('★ host'));
      if (p.seat === info.you) {
        li.classList.add('you');
        li.append(tag('you'));
      }
      list.append(li);
    }
    for (let i = people.length; i < MAX_PER_TEAM; i++) {
      const li = document.createElement('li');
      li.className = 'bot';
      li.textContent = 'Bot';
      list.append(li);
    }
    const joinBtn = document.querySelector<HTMLButtonElement>(`[data-join-team="${team}"]`)!;
    joinBtn.classList.toggle('hidden', !me || me.team === team || people.length >= MAX_PER_TEAM || info.started);
  }

  const isHost = info.you === info.host;
  const ready = info.players.some((p) => p.team === 0) && info.players.some((p) => p.team === 1);
  $('lobby-start').classList.toggle('hidden', info.isPublic || !isHost);
  ($('lobby-start') as HTMLButtonElement).disabled = !ready;
  lobbyCountdownEnd = info.startsIn !== null ? performance.now() + info.startsIn * 1000 : null;
  const host = info.players.find((p) => p.seat === info.host);
  let status: string;
  if (info.isPublic) status = ready ? '' : 'Waiting for more players…';
  else if (!ready) status = 'Waiting for someone on each team… share the code!';
  else if (isHost) status = 'Ready when you are. More friends can still join.';
  else status = `Waiting for ${host?.name ?? 'the host'} to start…`;
  $('lobby-status').textContent = status;
  updateLobbyCountdown();
}

function tag(text: string): HTMLElement {
  const small = document.createElement('small');
  small.textContent = text;
  return small;
}

function updateLobbyCountdown(): void {
  if (lobbyCountdownEnd === null || $('lobby').classList.contains('hidden')) return;
  const left = Math.max(0, Math.ceil((lobbyCountdownEnd - performance.now()) / 1000));
  $('lobby-status').textContent = `Starting in ${left}… (more people can still join)`;
}
setInterval(updateLobbyCountdown, 250);

/** A short message at the bottom of the screen, e.g. "Sam joined the match". */
function toast(text: string): void {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout((toast as unknown as { timer?: number }).timer);
  (toast as unknown as { timer?: number }).timer = window.setTimeout(() => el.classList.remove('show'), 2600);
}

