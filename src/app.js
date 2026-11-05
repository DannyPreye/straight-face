'use strict';

const { Session } = require('./session');
const { makeDeck, makeTauntDeck } = require('./decks');
const { renderCard } = require('./card');

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
const MODES = {
  straight: { label: 'Straight Face', limit: 45, lose: 'cracked' },
  stare: { label: 'Staring Contest', limit: 60, lose: 'blinked' },
};
const MAX_PLAYERS = 8;
const EMOJI = { angry: '😠', contempt: '😏', disgust: '🤢', fear: '😨', happy: '😄', neutral: '😐', sad: '😢', surprise: '😮' };

const $ = (id) => document.getElementById(id);
const session = new Session({ apiKey: API_KEY, debug: DEBUG });
const preview = $('preview');

// ---------------------------------------------------------------- screens

let screen = 'home';

function showScreen(name) {
  screen = name;
  for (const s of ['home', 'play', 'lab']) $(`screen-${s}`).hidden = s !== name;
  const slot = { play: 'play-video-slot', lab: 'lab-video-slot' }[name];
  if (slot) $(slot).append(preview);
  $('tagline').textContent = { home: 'The camera is watching', play: MODES[game.mode]?.label ?? '', lab: 'Signal lab' }[name];
}

function showError(title, detail) {
  $('error').hidden = false;
  $('error-title').textContent = title;
  $('error-detail').textContent = detail ?? '';
}

function clearError() {
  $('error').hidden = true;
}

async function goHome() {
  endRound(null);
  clearTimeout(idleHandle);
  labStopLocal();
  await session.stop();
  revokeCard();
  showScreen('home');
}

// ---------------------------------------------------------------- session wiring

session.addEventListener('status', ({ detail }) => {
  $('status').textContent = detail.label;
  $('status').dataset.tone = detail.tone;
});

session.addEventListener('validation', ({ detail }) => {
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
  if (detail.top) $('top').textContent = `${EMOJI[detail.top.name] ?? ''} ${detail.top.name}`.trim();
  onGameExpression(detail);
  onLabExpression(detail);
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
    $('heart-pill').hidden = false;
    $('hud-bpm').textContent = `${pulse.value.toFixed(0)} bpm`;
    $('hud-heart').style.setProperty('--beat', `${(60 / Math.max(40, pulse.value)).toFixed(2)}s`);
    $('hud-heart').dataset.beating = 'true';
  }
  onLabVitals(detail, { pulse, breathing, hrv });
});

session.addEventListener('error', ({ detail }) => {
  showError(detail.title, detail.detail);
  lab.errors.push(`${detail.title} ${detail.detail}`);
  endRound('error');
  session.stop();
});

session.addEventListener('stopped', () => {
  $('heart-pill').hidden = true;
  $('hud-heart').dataset.beating = 'false';
  $('viewfinder').dataset.live = 'false';
  $('lab-viewfinder').dataset.live = 'false';
  for (const id of ['validation', 'lab-validation']) $(id).hidden = true;
});

session.addEventListener('stream', () => {
  $('viewfinder').dataset.live = String(screen === 'play');
  $('lab-viewfinder').dataset.live = String(screen === 'lab');
  $(screen === 'lab' ? 'lab-validation' : 'validation').hidden = false;
  lab.camera = session.camera;
});

function setMeter(value) {
  const level = Math.max(0, Math.min(100, value));
  $('meter').style.setProperty('--level', level.toFixed(1));
  $('meter').setAttribute('aria-valuenow', level.toFixed(0));
  const state = level >= CRACK_LEVEL ? 'cracked' : level >= WOBBLE_LEVEL ? 'wobbling' : 'steady';
  $('meter-panel').dataset.state = state;
}

function blinkEyes() {
  const eyes = $('eyes');
  eyes.dataset.blink = 'true';
  setTimeout(() => { eyes.dataset.blink = 'false'; }, 180);
}

// ---------------------------------------------------------------- home setup

const players = [];

function renderPlayers() {
  const list = $('players');
  list.replaceChildren();
  players.forEach((p, i) => {
    const li = document.createElement('li');
    const label = document.createElement('label');
    label.className = 'sr-only';
    label.htmlFor = `player-${i}`;
    label.textContent = `Player ${i + 1} name`;
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
    li.append(num, label, input);
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

function addPlayer() {
  if (players.length >= MAX_PLAYERS) return;
  players.push({ name: '', best: { straight: null, stare: null } });
  renderPlayers();
  $(`player-${players.length - 1}`).focus();
}

function playerName(p, i) {
  return p.name.trim() || `Player ${i + 1}`;
}

// ---------------------------------------------------------------- game

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

function overlay({ kicker = '', title = '', text = '', action = null }) {
  $('overlay').hidden = false;
  $('overlay-kicker').textContent = kicker;
  $('overlay-title').textContent = title;
  $('overlay-text').textContent = text;
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
    score.textContent = row.best === null ? '—' : `${row.best.toFixed(1)}s`;
    li.append(name, score);
    list.append(li);
  }
  $('mode-chip').textContent = MODES[game.mode].label;
}

async function startPlay() {
  clearError();
  if (!API_KEY) return;
  game.mode = document.querySelector('input[name="mode"]:checked').value;
  const packs = [...document.querySelectorAll('input[name="pack"]:checked')].map((el) => el.value);
  game.deck = makeDeck(packs.length ? packs : ['general']);
  game.taunts = makeTauntDeck();
  game.photo = $('photo-opt').checked;
  game.turn = 0;
  for (const p of players) p.best = { straight: null, stare: null };

  $('meter-title').textContent = game.mode === 'stare' ? 'Eyes' : 'Crack-o-meter';
  $('meter').hidden = game.mode === 'stare';
  document.querySelector('.meter-scale').hidden = game.mode === 'stare';
  $('eyes').hidden = game.mode !== 'stare';
  $('result').hidden = true;
  showScreen('play');
  renderScoreboard();
  handoff();
}

function handoff() {
  clearTimers();
  game.phase = 'handoff';
  $('hud-top').hidden = true;
  $('prompt-card').hidden = true;
  renderScoreboard();
  const name = playerName(current(), game.turn % players.length);
  const rules = game.mode === 'stare'
    ? 'Keep your eyes open. The first blink ends your round.'
    : 'Prompts will try to make you smile. Keep the Crack-o-meter out of the red.';
  overlay({
    kicker: players.length > 1 ? 'Pass the laptop to' : 'Ready?',
    title: name,
    text: `${rules} Sit facing the camera with light on your face.`,
    action: { label: session.running ? 'Start round' : 'Turn on camera and start', run: beginRound },
  });
  armIdle();
}

function armIdle() {
  clearTimeout(idleHandle);
  idleHandle = setTimeout(async () => {
    if (game.phase !== 'handoff' || !session.running) return;
    await session.stop();
    handoff();
    $('overlay-text').textContent = 'The camera turned off after 3 idle minutes. Start when you’re ready.';
  }, IDLE_STOP_MS);
}

async function beginRound() {
  clearError();
  clearTimeout(idleHandle);
  revokeCard();
  $('result').hidden = true;
  if (!session.running) {
    overlay({ kicker: 'One moment', title: 'Checking your light…', text: 'The camera is warming up.' });
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
    kicker: 'Get your game face on',
    title: game.mode === 'stare' ? 'Look at the camera' : 'Neutral face, please',
    text: 'The round starts once we can see you clearly.',
  });
  const check = () => {
    if (game.phase !== 'settle') return;
    const now = performance.now();
    const faceOk = session.top && !game.faceLost;
    const calm = game.mode === 'stare' || (session.happy ?? 100) < WOBBLE_LEVEL;
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
      const hint = $('validation').textContent;
      $('overlay-text').textContent = !session.top
        ? `We can’t read your face yet. ${hint ? `The camera says: “${hint}”` : 'Check your light and framing.'}`
        : 'Relax your face. Think about tax forms.';
    }
    game.raf = requestAnimationFrame(check);
  };
  game.raf = requestAnimationFrame(check);
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
    overlay({ kicker: game.mode === 'stare' ? 'Eyes open' : 'Straight face', title: String(n), text: '' });
    $('overlay').dataset.count = 'true';
    n -= 1;
    later(tick, 800);
  };
  tick();
}

function goLive() {
  clearTimers();
  $('overlay').dataset.count = 'false';
  hideOverlay();
  game.phase = 'live';
  game.startedAt = performance.now();
  game.crackSince = 0;
  game.pulseStart = session.vitals.pulse?.value ?? null;
  $('hud-top').hidden = false;
  $('hud-player').textContent = playerName(current(), game.turn % players.length);

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
    $('prompt-card').hidden = true;
    game.timers.push(setInterval(nextPrompt, TAUNT_EVERY_MS));
  } else {
    nextPrompt();
    game.timers.push(setInterval(nextPrompt, PROMPT_EVERY_MS));
  }

  const limit = MODES[game.mode].limit;
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

// outcome: null (leaving), 'error', 'void', or a scored result
// ('cracked' | 'blinked' | 'unbreakable'), which only counts while live.
function endRound(outcome) {
  const scored = outcome === 'cracked' || outcome === 'blinked' || outcome === 'unbreakable';
  if ((scored || outcome === 'void') && game.phase !== 'live') return;

  const seconds = scored ? Math.min(MODES[game.mode].limit, (performance.now() - game.startedAt) / 1000) : 0;
  const photo = scored && game.photo ? session.snapshot() : null;
  clearTimers();
  $('prompt-card').hidden = true;
  $('hud-top').hidden = true;

  if (outcome === null) {
    game.phase = 'idle';
    return;
  }
  if (outcome === 'error') {
    game.phase = 'idle';
    if (screen === 'play') handoff();
    return;
  }
  game.phase = 'result';
  if (outcome === 'void') {
    $('flash').dataset.on = 'false';
    overlay({
      kicker: 'Round doesn’t count',
      title: 'We lost your face',
      text: 'Stay in frame, facing the camera. Have another go.',
      action: { label: 'Try again', run: beginRound },
    });
    return;
  }
  showResult(outcome, seconds, photo);
}

async function showResult(outcome, seconds, photo) {
  const idx = game.turn % players.length;
  const player = current();
  const name = playerName(player, idx);
  const prevBest = player.best[game.mode];
  const isBest = prevBest === null || seconds > prevBest;
  if (isBest) player.best[game.mode] = seconds;

  const flash = $('flash');
  flash.dataset.tone = outcome;
  flash.dataset.on = 'false';
  void flash.offsetWidth;
  flash.dataset.on = 'true';

  const titles = {
    cracked: `Cracked at ${seconds.toFixed(1)}s`,
    blinked: `Blinked at ${seconds.toFixed(1)}s`,
    unbreakable: 'Unbreakable!',
  };
  const kickers = {
    cracked: ['Gotcha.', 'There it is.', 'The smile escaped.', 'Caught you.'],
    blinked: ['Blink detected.', 'Eyes closed. Game over.', 'There it goes.'],
    unbreakable: ['Stone cold.', 'Not a flicker.', 'Ice in your veins.'],
  };
  const pick = (list) => list[Math.floor(Math.random() * list.length)];

  const nextIdx = (game.turn + 1) % players.length;
  const nextName = playerName(players[nextIdx], nextIdx);
  overlay({
    kicker: pick(kickers[outcome]),
    title: titles[outcome],
    text: isBest && prevBest !== null ? `New personal best for ${name}.` : '',
    action: {
      label: players.length > 1 ? `Next: ${nextName}` : 'Play again',
      run: () => { game.turn += 1; handoff(); },
    },
  });

  // Pulse before vs after, only if the SDK had a confident reading for both.
  const pulseEnd = session.vitals.pulse?.value ?? null;
  const pulseLine = $('result-pulse');
  if (game.pulseStart !== null && pulseEnd !== null) {
    pulseLine.hidden = false;
    pulseLine.textContent = `Pulse during the round: ${game.pulseStart.toFixed(0)} → ${pulseEnd.toFixed(0)} bpm`;
  } else {
    pulseLine.hidden = true;
  }

  const modeLabel = MODES[game.mode].label;
  const card = await renderCard({
    photo,
    outcome,
    seconds,
    player: name,
    modeLabel,
    prompt: outcome === 'cracked' ? game.prompt : null,
  });
  revokeCard();
  game.card = card;
  game.cardUrl = await new Promise((resolve) => card.toBlob((b) => resolve(URL.createObjectURL(b)), 'image/png'));
  $('result-card').src = game.cardUrl;
  $('result-line').textContent = outcome === 'cracked' && game.prompt
    ? `Broken by: ${game.prompt[0]} ${game.prompt[1]}`
    : '';
  $('result').hidden = false;
  renderScoreboard();
  armIdle();
}

function revokeCard() {
  if (game.cardUrl) URL.revokeObjectURL(game.cardUrl);
  game.cardUrl = null;
  game.card = null;
  $('result-card').removeAttribute('src');
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

function onLabVitals(_all, { pulse, breathing, hrv }) {
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

$('go-home').addEventListener('click', goHome);
$('leave-play').addEventListener('click', goHome);
$('add-player').addEventListener('click', addPlayer);
$('play').addEventListener('click', startPlay);
$('save-card').addEventListener('click', saveCard);
$('open-lab').addEventListener('click', () => { clearError(); showScreen('lab'); labRounds(); labReport(); });
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
  if (['INPUT', 'TEXTAREA', 'SUMMARY'].includes(tag)) return;
  if (event.code !== 'Space' || event.repeat) return;
  if (screen === 'lab') {
    event.preventDefault();
    labTrial();
  }
});

window.addEventListener('beforeunload', () => session.destroy());

// ---------------------------------------------------------------- boot

players.push({ name: '', best: { straight: null, stare: null } });
renderPlayers();
$('no-key').hidden = Boolean(API_KEY);
$('play').disabled = !API_KEY;
$('lab-start').disabled = !API_KEY;
showScreen('home');
// Debug builds only: lets an automated check drive the game with synthetic events.
if (DEBUG) window.__straightFace = { session, game, players };
console.log(`straight-face ready; key ${API_KEY ? 'present' : 'missing'}`);
