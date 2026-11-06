'use strict';

const { Session, MIN_BRIGHTNESS } = require('./session');
const { makeDeck, makeTauntDeck } = require('./decks');
const { renderCard } = require('./card');
const { createPacer, syncScore, drawWave, WAVE_WINDOW_S } = require('./cooldown');

// Injected by build.mjs from .env.
const API_KEY = __PRESAGE_API_KEY__;
const DEBUG = __DEBUG__;

// Game tuning. Smile level is the SDK's "happy" expression confidence (0-100).
const CRACK_LEVEL = 50;
const WOBBLE_LEVEL = 30;
const CRACK_HOLD_MS = 250;      // smile must stay above CRACK_LEVEL this long
const SETTLE_MS = 1200;         // neutral face needed before the countdown
const SETTLE_TIMEOUT_MS = 15000;
const FACE_LOST_VOID_MS = 1500; // a round with no readable face doesn't count
const BLINK_GRACE_MS = 400;     // ignore a blink already in progress at "Go"
const PROMPT_EVERY_MS = 6000;
const TAUNT_EVERY_MS = 5000;
const IDLE_STOP_MS = 3 * 60 * 1000;
const SYNC_EVERY_MS = 1000;
const SYNC_GRACE_S = 15;        // sync needs 15 s of guide + breath to measure
const CHECK_ANYWAY_MS = 20000;  // after this, allow starting with checks pending
const MAX_PLAYERS = 8;

const MODES = {
  straight: {
    label: 'Straight Face',
    limit: 45,
    emoji: '😐',
    how: [
      'A funny prompt pops up every few seconds.',
      'If the camera sees you smile, you’re out.',
      'Last 45 seconds and you’re unbreakable. Longest time wins.',
    ],
    packs: true,
    photo: true,
  },
  stare: {
    label: 'Staring Contest',
    limit: 60,
    emoji: '👁️',
    how: [
      'Look at the screen with your eyes open.',
      'The first blink the camera sees ends your round.',
      'Last 60 seconds and you’re unbreakable. Longest time wins.',
    ],
    packs: false,
    photo: true,
  },
  cool: {
    label: 'Cool Down',
    limit: 90,
    emoji: '🧘',
    how: [
      'A glowing guide grows as you breathe in and shrinks as you breathe out.',
      'It starts at your own pace and slowly gets slower.',
      'Follow it for 90 seconds. Your score is how closely your breath matched it.',
    ],
    packs: false,
    photo: false,
  },
};
const EMOJI = { angry: '😠', contempt: '😏', disgust: '🤢', fear: '😨', happy: '😄', neutral: '😐', sad: '😢', surprise: '😮' };

const $ = (id) => document.getElementById(id);
const session = new Session({ apiKey: API_KEY, debug: DEBUG });
const preview = $('preview');

// Cool Down scores are sync percentages; the other modes are seconds.
function fmtScore(mode, v) {
  return mode === 'cool' ? `${Math.round(v)}%` : `${v.toFixed(1)}s`;
}

// ---------------------------------------------------------------- screens

const STEPS = ['pick', 'setup', 'check', 'play'];
let screen = 'pick';

function showScreen(name) {
  screen = name;
  for (const s of [...STEPS, 'lab']) $(`screen-${s}`).hidden = s !== name;
  const slot = { check: 'check-video-slot', play: 'play-video-slot', lab: 'lab-video-slot' }[name];
  if (slot) $(slot).append(preview);
  const idx = STEPS.indexOf(name);
  $('stepper').dataset.off = String(idx < 0);
  for (const li of $('stepper').children) {
    const i = STEPS.indexOf(li.dataset.step);
    li.dataset.state = i < idx ? 'done' : i === idx ? 'now' : 'todo';
    if (i === idx) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
  }
}

function showError(title, detail) {
  $('error').hidden = false;
  $('error-title').textContent = title;
  $('error-detail').textContent = detail ?? '';
}

function clearError() {
  $('error').hidden = true;
}

async function goPick() {
  endRound(null);
  clearTimeout(idleHandle);
  stopCheck();
  labStopLocal();
  await session.stop();
  revokeCard();
  clearError();
  showScreen('pick');
}

// ---------------------------------------------------------------- session wiring

let lastValidation = null;

session.addEventListener('status', ({ detail }) => {
  $('status').textContent = detail.label;
  $('status').dataset.tone = detail.tone;
  check.live = detail.tone === 'live';
});

session.addEventListener('validation', ({ detail }) => {
  lastValidation = detail;
  for (const id of ['validation', 'lab-validation']) {
    const el = $(id);
    if (el.textContent !== detail.text) el.textContent = detail.text;
    el.dataset.tone = detail.ok ? 'ok' : 'warn';
  }
  game.faceLost = detail.faceLost;
  if (detail.faceLost) {
    if (!game.faceLostSince) game.faceLostSince = performance.now();
  } else {
    game.faceLostSince = 0;
  }
  lab.validation[detail.name] = (lab.validation[detail.name] ?? 0) + 1;
});

session.addEventListener('dark', () => {
  for (const id of ['validation', 'lab-validation']) {
    $(id).textContent = 'Too dark. Turn on a light in front of you.';
    $(id).dataset.tone = 'warn';
  }
});

session.addEventListener('expression', ({ detail }) => {
  setMeter(detail.happy ?? 0);
  onGameExpression(detail);
  onLabExpression(detail);
});

session.addEventListener('breathTrace', ({ detail }) => {
  const pts = detail.points;
  if (!pts.length) return;
  const nowS = performance.now() / 1000;
  // Map SDK timestamps onto our clock; re-anchor after a gap (reconnect).
  if (game.traceShift === null || nowS - game.lastTraceAt > 3) {
    game.traceShift = nowS - pts[pts.length - 1].t;
  }
  game.lastTraceAt = nowS;
  for (const p of pts) game.trace.push({ t: p.t + game.traceShift, v: p.v });
  while (game.trace.length && game.trace[0].t < nowS - WAVE_WINDOW_S - 5) game.trace.shift();
});

session.addEventListener('blink', ({ detail }) => {
  onGameBlink(detail);
  $('lab-blinks').textContent = String(detail.count);
  blinkEyes();
});

session.addEventListener('talking', ({ detail }) => {
  $('lab-talking').textContent = detail.detected ? 'Yes' : 'No';
});

session.addEventListener('vitals', ({ detail }) => {
  const { pulse, breathing, hrv } = detail;
  if (pulse) {
    $('rail-pulse').hidden = false;
    $('hud-bpm').textContent = `Pulse ${pulse.value.toFixed(0)} bpm`;
    $('hud-heart').style.setProperty('--beat', `${(60 / Math.max(40, pulse.value)).toFixed(2)}s`);
    $('hud-heart').dataset.beating = 'true';
  }
  onLabVitals({ pulse, breathing, hrv });
});

session.addEventListener('error', ({ detail }) => {
  showError(detail.title, detail.detail);
  lab.errors.push(`${detail.title} ${detail.detail}`);
  endRound('error');
  session.stop();
  if (screen === 'check') checkFailed(detail.title, detail.detail);
});

session.addEventListener('recovering', () => {
  const wasPlaying = ['settle', 'countdown', 'live'].includes(game.phase);
  clearTimers();
  hideRoundVisuals();
  if (screen === 'play') {
    game.phase = 'recovering';
    overlay({
      kicker: wasPlaying ? 'Round doesn’t count' : 'Hang on',
      title: 'Reconnecting…',
      text: 'The connection to Presage dropped for a moment. This takes a few seconds.',
    });
  }
  $('lab-validation').textContent = 'Connection dropped. Reconnecting…';
  $('lab-validation').dataset.tone = 'warn';
});

session.addEventListener('recovered', () => {
  if (screen === 'play' && game.phase === 'recovering') handoff('Back online.');
});

session.addEventListener('stopped', () => {
  game.trace = [];
  game.traceShift = null;
  lastValidation = null;
  check.live = false;
  $('rail-pulse').hidden = true;
  $('hud-heart').dataset.beating = 'false';
  for (const id of ['viewfinder', 'check-viewfinder', 'lab-viewfinder']) $(id).dataset.live = 'false';
  for (const id of ['validation', 'lab-validation']) $(id).hidden = true;
});

session.addEventListener('stream', () => {
  const vf = { play: 'viewfinder', check: 'check-viewfinder', lab: 'lab-viewfinder' }[screen];
  if (vf) $(vf).dataset.live = 'true';
  $('check-placeholder').hidden = true;
  if (screen === 'lab') $('lab-validation').hidden = false;
  lab.camera = session.camera;
});

function setMeter(value) {
  const level = Math.max(0, Math.min(100, value));
  $('vmeter').style.setProperty('--level', level.toFixed(1));
  $('stage').dataset.meter = level >= CRACK_LEVEL ? 'cracked' : level >= WOBBLE_LEVEL ? 'wobbling' : 'steady';
}

function blinkEyes() {
  const eyes = $('eyes');
  eyes.dataset.blink = 'true';
  setTimeout(() => { eyes.dataset.blink = 'false'; }, 180);
}

// ---------------------------------------------------------------- 1. pick + 2. setup

const players = [];

function chooseMode(mode) {
  clearError();
  game.mode = mode;
  const m = MODES[mode];
  $('setup-eyebrow').textContent = `How to play`;
  $('setup-title').textContent = `${m.emoji} ${m.label}`;
  const how = $('setup-how');
  how.replaceChildren();
  for (const line of m.how) {
    const li = document.createElement('li');
    li.textContent = line;
    how.append(li);
  }
  $('packs-block').hidden = !m.packs;
  $('photo-block').hidden = !m.photo;
  $('extras').hidden = !m.packs && !m.photo;
  showScreen('setup');
  $('to-check').focus();
}

function renderPlayers() {
  const list = $('players');
  list.replaceChildren();
  players.forEach((p, i) => {
    const li = document.createElement('li');
    const input = document.createElement('input');
    input.id = `player-${i}`;
    input.type = 'text';
    input.maxLength = 18;
    input.autocomplete = 'off';
    input.value = p.name;
    input.placeholder = `Player ${i + 1}`;
    input.setAttribute('aria-label', `Player ${i + 1} name`);
    input.addEventListener('input', () => { p.name = input.value; });
    const num = document.createElement('span');
    num.className = 'player-num';
    num.textContent = String(i + 1);
    li.append(num, input);
    if (players.length > 1) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn-icon';
      remove.setAttribute('aria-label', `Remove player ${i + 1}`);
      remove.textContent = '×';
      remove.addEventListener('click', () => { players.splice(i, 1); renderPlayers(); });
      li.append(remove);
    }
    list.append(li);
  });
  $('add-player').disabled = players.length >= MAX_PLAYERS;
}

function newPlayer() {
  return { name: '', best: { straight: null, stare: null, cool: null } };
}

function addPlayer() {
  if (players.length >= MAX_PLAYERS) return;
  players.push(newPlayer());
  renderPlayers();
  $(`player-${players.length - 1}`).focus();
}

function playerName(p, i) {
  return p.name.trim() || `Player ${i + 1}`;
}

// ---------------------------------------------------------------- 3. camera check

const check = { timer: 0, since: 0, live: false, failed: false };

function setItem(id, state) {
  $(id).dataset.state = state;
}

async function enterCheck() {
  clearError();
  showScreen('check');
  check.failed = false;
  check.since = performance.now();
  $('check-retry').hidden = true;
  $('check-placeholder').hidden = false;
  $('chk-chest').hidden = game.mode !== 'cool';
  for (const id of ['chk-signal', 'chk-light', 'chk-face', 'chk-chest']) setItem(id, 'wait');
  $('start-game').disabled = true;
  $('start-game').textContent = 'Start the game';
  $('check-hint').textContent = 'Checking your light…';
  clearInterval(check.timer);
  check.timer = setInterval(updateCheck, 300);

  if (!session.running) {
    const res = await session.start(preview);
    if (screen !== 'check') return;
    if (!res.ok) {
      checkFailed(res.title, res.detail, res.reason);
      return;
    }
  }
}

function checkFailed(title, detail, reason) {
  check.failed = true;
  clearInterval(check.timer);
  setItem(reason === 'dark' ? 'chk-light' : 'chk-signal', 'bad');
  $('check-hint').textContent = `${title} ${detail ?? ''}`.trim();
  $('check-retry').hidden = false;
  $('start-game').disabled = true;
}

function stopCheck() {
  clearInterval(check.timer);
}

function updateCheck() {
  if (screen !== 'check' || check.failed) return;
  const nowMs = performance.now();
  const results = {};

  results.signal = check.live ? 'ok' : 'wait';

  const b = session.brightness;
  results.light = b === null ? (session.lightCheck !== null && session.lightCheck >= MIN_BRIGHTNESS && check.live ? 'ok' : 'wait')
    : b >= MIN_BRIGHTNESS ? 'ok' : 'bad';

  if (!lastValidation) results.face = 'wait';
  else results.face = !lastValidation.faceLost && session.top ? 'ok' : lastValidation.faceLost ? 'bad' : 'wait';

  if (game.mode === 'cool') {
    const flowing = game.trace.length > 0 && nowMs / 1000 - game.lastTraceAt < 2;
    const chestHidden = lastValidation?.name === 'ChestNotVisible';
    results.chest = chestHidden ? 'bad' : flowing ? 'ok' : 'wait';
  }

  setItem('chk-signal', results.signal);
  setItem('chk-light', results.light);
  setItem('chk-face', results.face);
  if (results.chest) setItem('chk-chest', results.chest);

  const pending = Object.entries(results).filter(([, s]) => s !== 'ok');
  const ready = pending.length === 0;
  const waitedLong = nowMs - check.since > CHECK_ANYWAY_MS;

  const advice = {
    signal: 'Connecting to Presage…',
    light: 'Too dark: turn on a lamp in front of you, or face a window.',
    face: lastValidation?.text ? `Camera says: ${lastValidation.text}` : 'Look at the screen so the camera can find your face.',
    chest: 'Sit back so your upper chest is in view, and keep the laptop still on a table.',
  };
  $('check-hint').textContent = ready ? 'All set. Press Start when you’re ready.' : advice[pending[0][0]];

  $('start-game').disabled = !(ready || (waitedLong && check.live));
  $('start-game').textContent = ready || !waitedLong ? 'Start the game' : 'Start anyway';
}

// ---------------------------------------------------------------- 4. game

const game = {
  mode: 'straight',
  phase: 'idle',
  turn: 0,
  deck: null,
  taunts: null,
  prompt: null,
  startedAt: 0,
  crackSince: 0,
  faceLost: false,
  faceLostSince: 0,
  settleSince: 0,
  phaseSince: 0,
  pulseStart: null,
  timers: [],
  raf: 0,
  photo: false,
  card: null,
  cardUrl: null,
  // Cool Down: guide + measured chest waveform, both on performance.now()/1000.
  trace: [],
  traceShift: null,
  lastTraceAt: 0,
  guide: [],
  syncs: [],
  pacer: null,
  breathIn: null,
};
let idleHandle = 0;

function later(fn, ms) {
  game.timers.push(setTimeout(fn, ms));
}

function clearTimers() {
  for (const t of game.timers) clearTimeout(t);
  for (const t of game.timers) clearInterval(t);
  game.timers = [];
  cancelAnimationFrame(game.raf);
}

// One overlay on the stage for every between-rounds moment.
function overlay({ kicker = '', title = '', text = '', action = null, card = null }) {
  $('overlay').hidden = false;
  $('stage').dataset.overlay = 'true';
  $('overlay-kicker').textContent = kicker;
  $('overlay-title').textContent = title;
  $('overlay-text').textContent = text;
  $('overlay-card').hidden = !card;
  if (card) $('overlay-card').src = card;
  $('save-card').hidden = !card;
  const btn = $('overlay-action');
  btn.hidden = !action;
  if (action) {
    btn.textContent = action.label;
    btn.onclick = action.run;
    btn.focus({ preventScroll: true });
  }
}

function hideOverlay() {
  $('overlay').hidden = true;
  $('stage').dataset.overlay = 'false';
  $('overlay').dataset.count = 'false';
}

function hideRoundVisuals() {
  $('prompt-card').hidden = true;
  $('hud').hidden = true;
  $('pacer').hidden = true;
  $('breath-strip').hidden = true;
}

function current() {
  return players[game.turn % players.length];
}

function renderScoreboard() {
  const list = $('scoreboard');
  list.replaceChildren();
  const ranked = players
    .map((p, i) => ({ name: playerName(p, i), best: p.best[game.mode], up: i === game.turn % players.length }))
    .sort((a, b) => (b.best ?? -1) - (a.best ?? -1));
  for (const row of ranked) {
    const li = document.createElement('li');
    if (row.up) li.dataset.up = 'true';
    const name = document.createElement('span');
    name.textContent = row.name;
    const score = document.createElement('span');
    score.className = 'score';
    score.textContent = row.best === null ? '—' : fmtScore(game.mode, row.best);
    li.append(name, score);
    list.append(li);
  }
}

function startPlay() {
  stopCheck();
  clearError();
  const packs = [...document.querySelectorAll('input[name="pack"]:checked')].map((el) => el.value);
  game.deck = makeDeck(packs.length ? packs : ['general']);
  game.taunts = makeTauntDeck();
  game.photo = MODES[game.mode].photo && $('photo-opt').checked;
  game.turn = 0;
  for (const p of players) p.best = { straight: null, stare: null, cool: null };

  $('stage').dataset.mode = game.mode;
  $('rail-mode').textContent = `${MODES[game.mode].emoji} ${MODES[game.mode].label}`;
  $('vmeter').hidden = game.mode !== 'straight';
  $('eyes').hidden = game.mode !== 'stare';
  $('validation').hidden = false;
  showScreen('play');
  handoff();
}

function handoff(kickerOverride) {
  clearTimers();
  game.phase = 'handoff';
  hideRoundVisuals();
  revokeCard();
  renderScoreboard();
  const name = playerName(current(), game.turn % players.length);
  overlay({
    kicker: kickerOverride ?? (players.length > 1 ? 'Your turn' : 'Ready?'),
    title: name,
    text: MODES[game.mode].how[1],
    action: { label: session.running ? 'Start round' : 'Turn on camera and start', run: beginRound },
  });
  armIdle();
}

function armIdle() {
  clearTimeout(idleHandle);
  idleHandle = setTimeout(async () => {
    if (!['handoff', 'result'].includes(game.phase) || !session.running) return;
    await session.stop();
    handoff('Camera paused');
    $('overlay-text').textContent = 'The camera turned off after 3 idle minutes. Start when you’re ready.';
  }, IDLE_STOP_MS);
}

async function beginRound() {
  clearError();
  clearTimeout(idleHandle);
  revokeCard();
  if (!session.running) {
    overlay({ kicker: 'One moment', title: 'Starting the camera…' });
    const res = await session.start(preview);
    if (!res.ok) {
      showError(res.title, res.detail);
      handoff();
      return;
    }
  }
  settle();
}

function settle() {
  clearTimers();
  game.phase = 'settle';
  game.settleSince = 0;
  game.phaseSince = performance.now();
  overlay({
    kicker: 'Get ready',
    title: { stare: 'Eyes on the screen', straight: 'Neutral face', cool: 'Breathe normally' }[game.mode],
    text: 'Starting as soon as the camera can see you.',
  });
  const step = () => {
    if (game.phase !== 'settle') return;
    const now = performance.now();
    const faceOk = session.top && !game.faceLost;
    const breathing = game.trace.length > 0 && now / 1000 - game.lastTraceAt < 2;
    const calm = game.mode === 'stare'
      || (game.mode === 'cool' ? breathing : (session.happy ?? 100) < WOBBLE_LEVEL);
    if (faceOk && calm) {
      if (!game.settleSince) game.settleSince = now;
      if (now - game.settleSince >= SETTLE_MS) {
        countdown();
        return;
      }
    } else {
      game.settleSince = 0;
    }
    if (now - game.phaseSince > SETTLE_TIMEOUT_MS) {
      $('overlay-text').textContent = !session.top
        ? `We can’t see your face. ${lastValidation?.text ? `Camera says: ${lastValidation.text}` : 'Check your light and framing.'}`
        : game.mode === 'cool'
          ? 'We can’t see your breathing. Sit back so your upper chest is in view.'
          : 'Relax your face. Think about tax forms.';
    }
    game.raf = requestAnimationFrame(step);
  };
  game.raf = requestAnimationFrame(step);
}

function countdown() {
  clearTimers();
  game.phase = 'countdown';
  let n = 3;
  const tick = () => {
    if (game.phase !== 'countdown') return;
    if (n === 0) {
      goLive();
      return;
    }
    overlay({ kicker: { stare: 'Eyes open', straight: 'Straight face', cool: 'Follow the guide' }[game.mode], title: String(n) });
    $('overlay').dataset.count = 'true';
    n -= 1;
    later(tick, 800);
  };
  tick();
}

function goLive() {
  clearTimers();
  hideOverlay();
  game.phase = 'live';
  game.startedAt = performance.now();
  game.crackSince = 0;
  game.pulseStart = session.vitals.pulse?.value ?? null;
  $('hud').hidden = false;
  $('hud-player').textContent = playerName(current(), game.turn % players.length);

  const limit = MODES[game.mode].limit;
  if (game.mode === 'cool') {
    startCoolDown(limit);
    return;
  }

  const nextPrompt = () => {
    game.prompt = game.mode === 'stare' ? game.taunts() : game.deck();
    $('prompt-emoji').textContent = game.prompt[0];
    $('prompt-text').textContent = game.prompt[1];
    const card = $('prompt-card');
    card.hidden = false;
    card.dataset.anim = 'false';
    void card.offsetWidth;
    card.dataset.anim = 'true';
  };
  if (game.mode === 'stare') {
    game.prompt = null;
    game.timers.push(setInterval(nextPrompt, TAUNT_EVERY_MS));
  } else {
    nextPrompt();
    game.timers.push(setInterval(nextPrompt, PROMPT_EVERY_MS));
  }

  const frame = () => {
    if (game.phase !== 'live') return;
    const t = (performance.now() - game.startedAt) / 1000;
    $('hud-timer').textContent = t.toFixed(1);
    if (game.faceLostSince && performance.now() - game.faceLostSince > FACE_LOST_VOID_MS) {
      endRound('void');
      return;
    }
    if (t >= limit) {
      endRound('unbreakable');
      return;
    }
    game.raf = requestAnimationFrame(frame);
  };
  game.raf = requestAnimationFrame(frame);
}

function startCoolDown(limit) {
  const measured = session.vitals.breathing?.value ?? null;
  const pacer = createPacer(measured, limit);
  game.pacer = pacer;
  game.guide = [];
  game.syncs = [];
  game.breathIn = null;
  game.prompt = null;
  $('pacer').hidden = false;
  $('breath-strip').hidden = false;
  $('cue-sub').textContent = measured === null
    ? `Starting at ${pacer.start} breaths a minute`
    : `Starting at your pace: ${pacer.start.toFixed(0)} breaths a minute`;
  $('sync-value').textContent = '…';

  let last = performance.now();
  let lastSync = 0;
  const frame = () => {
    if (game.phase !== 'live') return;
    const nowMs = performance.now();
    const t = (nowMs - game.startedAt) / 1000;
    const dt = Math.min(0.1, (nowMs - last) / 1000);
    last = nowMs;
    const step = pacer.step(t, dt);
    $('pacer').style.setProperty('--s', (0.3 + 0.7 * step.level).toFixed(3));
    if (step.inhaling !== game.breathIn) {
      game.breathIn = step.inhaling;
      $('cue').textContent = step.inhaling ? 'Breathe in' : 'Breathe out';
    }
    if (t > 8) $('cue-sub').textContent = String(Math.ceil(step.leftInPhase));
    $('hud-timer').textContent = Math.max(0, limit - t).toFixed(0);

    const nowS = nowMs / 1000;
    game.guide.push({ t: nowS, v: step.level });
    while (game.guide.length && game.guide[0].t < nowS - WAVE_WINDOW_S - 5) game.guide.shift();
    drawWave($('calm-wave'), game.guide, game.trace, nowS);

    if (t >= SYNC_GRACE_S && nowMs - lastSync >= SYNC_EVERY_MS) {
      lastSync = nowMs;
      const s = syncScore(game.guide, game.trace, nowS);
      if (s !== null) {
        game.syncs.push(s);
        $('sync-value').textContent = `${s}%`;
      }
    }
    if (game.faceLostSince && nowMs - game.faceLostSince > FACE_LOST_VOID_MS) {
      endRound('void');
      return;
    }
    if (t >= limit) {
      endRound('synced');
      return;
    }
    game.raf = requestAnimationFrame(frame);
  };
  game.raf = requestAnimationFrame(frame);
}

function onGameExpression({ happy, at }) {
  if (game.phase !== 'live' || game.mode !== 'straight' || happy === null) return;
  if (happy >= CRACK_LEVEL) {
    if (!game.crackSince) game.crackSince = at;
    if (at - game.crackSince >= CRACK_HOLD_MS) endRound('cracked');
  } else {
    game.crackSince = 0;
  }
}

function onGameBlink({ at }) {
  if (game.phase !== 'live' || game.mode !== 'stare') return;
  if (at - game.startedAt < BLINK_GRACE_MS) return;
  endRound('blinked');
}

// outcome: null (leaving), 'error', 'void', 'nobreath', or a scored result
// ('cracked' | 'blinked' | 'unbreakable' | 'synced'), which only counts while live.
function endRound(outcome) {
  if (outcome === 'synced' && !game.syncs.length) outcome = 'nobreath';
  const scored = ['cracked', 'blinked', 'unbreakable', 'synced'].includes(outcome);
  if ((scored || outcome === 'void' || outcome === 'nobreath') && game.phase !== 'live') return;

  const score = outcome === 'synced'
    ? game.syncs.reduce((s, v) => s + v, 0) / game.syncs.length
    : scored ? Math.min(MODES[game.mode].limit, (performance.now() - game.startedAt) / 1000) : 0;
  const photo = scored && game.photo ? session.snapshot() : null;
  clearTimers();
  hideRoundVisuals();

  if (outcome === null) {
    game.phase = 'idle';
    return;
  }
  if (outcome === 'error') {
    game.phase = 'idle';
    if (screen === 'play') handoff('Something went wrong');
    return;
  }
  game.phase = 'result';
  if (outcome === 'void' || outcome === 'nobreath') {
    overlay({
      kicker: 'Round doesn’t count',
      title: outcome === 'void' ? 'We lost your face' : 'We couldn’t see your breathing',
      text: outcome === 'void'
        ? 'Stay in frame, facing the screen.'
        : 'Keep the laptop still on a table and sit back so your upper chest is in view.',
      action: { label: 'Try again', run: beginRound },
    });
    armIdle();
    return;
  }
  showResult(outcome, score, photo);
}

async function showResult(outcome, score, photo) {
  const idx = game.turn % players.length;
  const player = current();
  const name = playerName(player, idx);
  const prevBest = player.best[game.mode];
  const isBest = prevBest === null || score > prevBest;
  if (isBest) player.best[game.mode] = score;
  renderScoreboard();

  const flash = $('flash');
  flash.dataset.tone = outcome;
  flash.dataset.on = 'false';
  void flash.offsetWidth;
  flash.dataset.on = 'true';

  const titles = {
    cracked: `Cracked at ${score.toFixed(1)}s`,
    blinked: `Blinked at ${score.toFixed(1)}s`,
    unbreakable: 'Unbreakable!',
    synced: `${Math.round(score)}% in sync`,
  };
  const kickers = {
    cracked: ['Gotcha.', 'There it is.', 'The smile escaped.', 'Caught you.'],
    blinked: ['Blink spotted.', 'Eyes closed.', 'There it goes.'],
    unbreakable: ['Stone cold.', 'Not a flicker.', 'Ice in your veins.'],
    synced: score >= 70 ? ['Smooth.', 'Right on the beat.'] : ['Nice and slow.', 'Good effort.'],
  };
  const pick = (list) => list[Math.floor(Math.random() * list.length)];

  // Pulse before vs after, only if the SDK had a confident reading for both.
  const pulseEnd = session.vitals.pulse?.value ?? null;
  const lines = [];
  if (outcome === 'cracked' && game.prompt) lines.push(`Broken by: “${game.prompt[1]}”`);
  if (game.pulseStart !== null && pulseEnd !== null) {
    lines.push(`Pulse ${game.pulseStart.toFixed(0)} → ${pulseEnd.toFixed(0)} bpm.`);
  }
  if (isBest && prevBest !== null) lines.push(`New personal best for ${name}.`);

  const nextIdx = (game.turn + 1) % players.length;
  const nextName = playerName(players[nextIdx], nextIdx);
  const action = {
    label: players.length > 1 ? `Next: ${nextName}` : 'Play again',
    run: () => { game.turn += 1; handoff(); },
  };

  const card = await renderCard({
    photo,
    outcome,
    seconds: score,
    scoreText: fmtScore(game.mode, score),
    player: name,
    modeLabel: MODES[game.mode].label,
    prompt: outcome === 'cracked' ? game.prompt : null,
  });
  revokeCard();
  game.card = card;
  game.cardUrl = await new Promise((resolve) => card.toBlob((b) => resolve(URL.createObjectURL(b)), 'image/png'));
  if (game.phase !== 'result') return;
  overlay({ kicker: pick(kickers[outcome]), title: titles[outcome], text: lines.join(' '), action, card: game.cardUrl });
  armIdle();
}

function revokeCard() {
  if (game.cardUrl) URL.revokeObjectURL(game.cardUrl);
  game.cardUrl = null;
  game.card = null;
  $('overlay-card').removeAttribute('src');
  $('overlay-card').hidden = true;
  $('save-card').hidden = true;
}

function saveCard() {
  if (!game.cardUrl) return;
  const idx = game.turn % players.length;
  const safe = playerName(current(), idx).replace(/[^\w-]+/g, '-').toLowerCase();
  const a = document.createElement('a');
  a.href = game.cardUrl;
  a.download = `straight-face-${safe}.png`;
  a.click();
}

// ---------------------------------------------------------------- signal lab

const LAB_LIMIT_S = 180;
const WARM_UP_S = { pulse: 12, breathing: 30, hrv: 60 };
const lab = {
  timer: 0,
  trial: null,
  lags: [],
  maxHappy: null,
  times: [],
  firstSeconds: {},
  validation: {},
  latest: {},
  errors: [],
  camera: null,
};

function labMark(name) {
  if (lab.firstSeconds[name] === undefined) lab.firstSeconds[name] = Number(session.elapsedSeconds().toFixed(1));
}

function labReport() {
  const sorted = [...lab.lags].sort((a, b) => a - b);
  $('report').value = JSON.stringify({
    camera: lab.camera,
    lightCheck: session.lightCheck,
    brightness: session.brightness,
    firstSeconds: lab.firstSeconds,
    expressionUpdatesPerSec: lab.rate ?? null,
    maxHappy: lab.maxHappy,
    blinks: session.blinks,
    smileLagsMs: lab.lags,
    smileLagMedianMs: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
    validationCounts: lab.validation,
    latest: lab.latest,
    errors: lab.errors,
  }, null, 2);
}

function labRounds() {
  const list = $('lab-rounds');
  list.replaceChildren();
  for (let i = 0; i < 5; i++) {
    const li = document.createElement('li');
    if (lab.lags[i] !== undefined) {
      li.dataset.done = 'true';
      li.textContent = `${lab.lags[i]} ms`;
    } else {
      li.textContent = String(i + 1);
      if (i === lab.lags.length && lab.trial) li.dataset.active = 'true';
    }
    list.append(li);
  }
}

function onLabExpression({ happy, top, at }) {
  if (screen !== 'lab' || !session.running) return;
  labMark('expression');
  lab.times.push(at);
  lab.times = lab.times.filter((t) => at - t <= 5000);
  lab.rate = Number((lab.times.length / 5).toFixed(1));
  $('lab-rate').textContent = `${lab.rate}/s`;
  if (top) $('lab-top').textContent = `${EMOJI[top.name] ?? ''} ${top.name} ${top.value.toFixed(0)}%`;
  if (happy === null) return;
  lab.maxHappy = Math.max(lab.maxHappy ?? 0, happy);
  $('lab-happy').textContent = `${happy.toFixed(0)}%`;
  if (lab.trial && happy >= CRACK_LEVEL) {
    clearTimeout(lab.trial.timeout);
    lab.lags.push(Math.round(at - lab.trial.startedAt));
    lab.trial = null;
    labRounds();
    $('lab-smile-state').textContent = lab.lags.length >= 5 ? 'Done.' : 'Caught you. Relax, then go again.';
  }
  labReport();
}

function onLabVitals({ pulse, breathing, hrv }) {
  if (screen !== 'lab') return;
  for (const [key, v] of Object.entries({ pulse, breathing, hrv })) {
    if (!v) continue;
    labMark(`${key} (confidence above 0)`);
    lab.latest[key] = { value: Number(v.value.toFixed(1)), confidence: Math.round(v.confidence) };
    $(`lab-${key}`).textContent = `${v.value.toFixed(0)} ${{ pulse: 'bpm', breathing: '/min', hrv: 'ms' }[key]}`;
  }
}

function labTick() {
  const elapsed = session.elapsedSeconds();
  const left = Math.max(0, Math.ceil(LAB_LIMIT_S - elapsed));
  $('lab-timer').textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  if (session.brightness !== null) $('lab-bright').textContent = `${session.brightness}/255`;
  for (const key of Object.keys(WARM_UP_S)) {
    if (lab.latest[key]) continue;
    const s = Math.ceil(WARM_UP_S[key] - elapsed);
    $(`lab-${key}`).textContent = s > 0 ? `Warming up · ${s}s` : 'Hold still…';
  }
  if (left === 0) labStop();
}

async function labStart() {
  clearError();
  Object.assign(lab, { lags: [], maxHappy: null, times: [], firstSeconds: {}, validation: {}, latest: {}, errors: [], trial: null });
  for (const id of ['happy', 'top', 'blinks', 'pulse', 'breathing', 'hrv', 'talking', 'rate', 'bright']) $(`lab-${id}`).textContent = '—';
  labRounds();
  $('lab-start').disabled = true;
  const res = await session.start(preview);
  $('lab-start').disabled = false;
  if (!res.ok) {
    showError(res.title, res.detail);
    lab.errors.push(`${res.title} ${res.detail}`);
    labReport();
    return;
  }
  $('lab-overlay').hidden = true;
  $('lab-stop').disabled = false;
  $('lab-smile-state').textContent = 'Wait for the smile reading, then press Space as you smile.';
  lab.timer = setInterval(labTick, 500);
  labReport();
}

function labStopLocal() {
  clearInterval(lab.timer);
  if (lab.trial) clearTimeout(lab.trial.timeout);
  lab.trial = null;
  $('lab-timer').textContent = '';
  $('lab-stop').disabled = true;
  $('lab-overlay').hidden = false;
}

async function labStop() {
  labStopLocal();
  await session.stop();
  labReport();
}

function labTrial() {
  if (!session.running || lab.trial || lab.lags.length >= 5) return;
  if (session.happy === null) {
    $('lab-smile-state').textContent = 'No smile reading yet. Give it a moment.';
    return;
  }
  if (session.happy >= WOBBLE_LEVEL) {
    $('lab-smile-state').textContent = 'Straighten that face first, then try again.';
    return;
  }
  const timeout = setTimeout(() => {
    lab.trial = null;
    labRounds();
    $('lab-smile-state').textContent = `The reading never reached ${CRACK_LEVEL}%. Try a bigger smile (peak so far: ${(lab.maxHappy ?? 0).toFixed(0)}%).`;
  }, 5000);
  lab.trial = { startedAt: performance.now(), timeout };
  labRounds();
  $('lab-smile-state').textContent = 'Smile!';
}

// ---------------------------------------------------------------- events

for (const tile of document.querySelectorAll('.game-tile')) {
  tile.addEventListener('click', () => chooseMode(tile.dataset.mode));
}
$('go-home').addEventListener('click', goPick);
$('leave-play').addEventListener('click', goPick);
$('setup-back').addEventListener('click', () => showScreen('pick'));
$('to-check').addEventListener('click', enterCheck);
$('check-back').addEventListener('click', async () => { stopCheck(); await session.stop(); clearError(); showScreen('setup'); });
$('check-retry').addEventListener('click', async () => { await session.stop(); enterCheck(); });
$('start-game').addEventListener('click', startPlay);
$('add-player').addEventListener('click', addPlayer);
$('save-card').addEventListener('click', saveCard);
$('open-lab').addEventListener('click', () => { clearError(); showScreen('lab'); labRounds(); labReport(); });
$('lab-back').addEventListener('click', goPick);
$('lab-start').addEventListener('click', labStart);
$('lab-stop').addEventListener('click', labStop);
$('copy').addEventListener('click', () => {
  $('report').select();
  document.execCommand('copy');
  $('copy').textContent = 'Copied';
  setTimeout(() => { $('copy').textContent = 'Copy results'; }, 1500);
});

window.addEventListener('keydown', (event) => {
  const tag = event.target.tagName;
  if (['INPUT', 'TEXTAREA', 'SUMMARY', 'BUTTON'].includes(tag)) return;
  if (event.code !== 'Space' || event.repeat) return;
  if (screen === 'lab') {
    event.preventDefault();
    labTrial();
  }
});

window.addEventListener('beforeunload', () => session.destroy());

// ---------------------------------------------------------------- boot

players.push(newPlayer());
renderPlayers();
$('no-key').hidden = Boolean(API_KEY);
for (const tile of document.querySelectorAll('.game-tile')) tile.disabled = !API_KEY;
$('lab-start').disabled = !API_KEY;
showScreen('pick');
// Debug builds only: lets an automated check drive the game with synthetic events.
if (DEBUG) window.__straightFace = { session, game, players, check };
console.log(`straight-face ready; key ${API_KEY ? 'present' : 'missing'}`);
