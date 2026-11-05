'use strict';

// Calibration booth: measures, on the real camera and in real lighting, what
// the game can rely on. No reading is stored or sent by this code.

const {
  SmartSpectraSDK,
  ProcessingStatus,
  ValidationCode,
  SmartSpectraErrorCode,
  SmartSpectraLogLevel,
  breathingMetrics,
  cardioMetrics,
  faceMetrics,
} = require('@smartspectra/node-sdk/renderer');
const { decodeMetrics } = require('@smartspectra/node-sdk/messages');

// Injected by build.mjs from .env.
const API_KEY = __PRESAGE_API_KEY__;
const DEBUG = __DEBUG__;

const SESSION_LIMIT_S = 180;
const SMILE_THRESHOLD = 50;
const NEUTRAL_LIMIT = 30;
const SMILE_TIMEOUT_MS = 5000;
const SMILE_TRIALS = 5;

// Analysis windows from Presage's "Getting a Good Measurement" guide.
const WARM_UP_S = { pulse: 12, breathing: 30, hrv: 60 };

const EXPRESSIONS = {
  1: ['angry', '😠'],
  2: ['contempt', '😏'],
  3: ['disgust', '🤢'],
  4: ['fear', '😨'],
  5: ['happy', '😄'],
  6: ['neutral', '😐'],
  7: ['sad', '😢'],
  8: ['surprise', '😮'],
};
const EXPRESSION_BY_NAME = Object.fromEntries(Object.values(EXPRESSIONS).map(([n, e]) => [n, e]));

const STATUS_LABELS = {
  [ProcessingStatus.kStarting]: ['Starting', 'busy'],
  [ProcessingStatus.kRunning]: ['Live', 'live'],
  [ProcessingStatus.kStopping]: ['Stopping', 'busy'],
  [ProcessingStatus.kError]: ['Error', 'error'],
  [ProcessingStatus.kIdle]: ['Camera off', 'idle'],
  [ProcessingStatus.kUninitialized]: ['Camera off', 'idle'],
};
const VALIDATION_NAMES = Object.fromEntries(
  Object.entries(ValidationCode).map(([k, v]) => [v, k.replace(/^k/, '')]),
);
const ERROR_NAMES = Object.fromEntries(
  Object.entries(SmartSpectraErrorCode).map(([k, v]) => [v, k.replace(/^k/, '')]),
);
const ERROR_TITLES = {
  [SmartSpectraErrorCode.kAuthenticationFailed]: 'Your API key was rejected.',
  [SmartSpectraErrorCode.kCreditExhausted]: 'Your Presage trial credits have run out.',
  [SmartSpectraErrorCode.kNetworkError]: 'Could not reach Presage. Check your connection.',
  [SmartSpectraErrorCode.kServerError]: 'Presage’s server had a problem. Try again shortly.',
  [SmartSpectraErrorCode.kInputUnavailable]: 'The camera could not be opened.',
  [SmartSpectraErrorCode.kProcessingFailed]: 'The SDK stopped reading your camera. This can happen when the picture is too dark.',
  [SmartSpectraErrorCode.kFrameConversionFailed]: 'The SDK could not read your camera’s video format.',
};

// Average brightness on a 0-255 scale. Below this the face is too dark for
// the SDK to read. A webcam frame in an unlit room measured about 6.
const MIN_BRIGHTNESS = 40;
const LIGHT_CHECK_MS = 1500;

const $ = (id) => document.getElementById(id);

const sampler = document.createElement('canvas');
sampler.width = 64;
sampler.height = 36;
const samplerCtx = sampler.getContext('2d', { willReadFrequently: true });
let brightnessHandle = null;
let lastBrightness = null;

// Mean luma of a downscaled frame. Returns null until the video has a frame.
function measureBrightness(video) {
  if (video.readyState < 2) return null;
  samplerCtx.drawImage(video, 0, 0, sampler.width, sampler.height);
  const { data } = samplerCtx.getImageData(0, 0, sampler.width, sampler.height);
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return sum / (data.length / 4);
}

// Opens the camera briefly, lets auto-exposure settle, and reports the
// brightest reading. The camera is released before the SDK takes it.
async function checkLighting() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 1280, height: 720 },
    audio: false,
  });
  const video = document.createElement('video');
  video.muted = true;
  video.srcObject = stream;
  try {
    await video.play();
    let best = null;
    const until = performance.now() + LIGHT_CHECK_MS;
    while (performance.now() < until) {
      await new Promise((r) => setTimeout(r, 150));
      const value = measureBrightness(video);
      if (value !== null) best = Math.max(best ?? 0, value);
    }
    return best;
  } finally {
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  }
}

function watchBrightness() {
  clearInterval(brightnessHandle);
  brightnessHandle = setInterval(() => {
    const value = measureBrightness($('preview'));
    if (value === null) return;
    lastBrightness = Math.round(value);
    results.brightness = lastBrightness;
    if (value < MIN_BRIGHTNESS) {
      $('validation').textContent = 'Too dark. Turn on a light in front of you.';
      $('validation').dataset.tone = 'warn';
    }
  }, 1000);
}

let sdk = null;
let startedAt = 0;
let tickHandle = null;
let results = newResults();
let currentHappy = null;
let wasBlinking = false;
let smileTrial = null;
let expressionTimes = [];

function newResults() {
  return {
    camera: null,
    lightCheck: null,
    brightness: null,
    firstSeconds: {},
    expressionUpdatesPerSec: null,
    maxHappy: null,
    blinks: 0,
    smileLagsMs: [],
    validationCounts: {},
    latest: {},
    errors: [],
  };
}

function elapsedSeconds() {
  return (performance.now() - startedAt) / 1000;
}

function markFirst(name) {
  if (results.firstSeconds[name] === undefined) {
    results.firstSeconds[name] = Number(elapsedSeconds().toFixed(1));
  }
}

// The enum may decode as a number or as its name, depending on the decoder.
function expressionName(type) {
  return typeof type === 'number' ? EXPRESSIONS[type]?.[0] : String(type).toLowerCase();
}

function setMeter(value) {
  const level = Math.max(0, Math.min(100, value));
  const meter = $('meter');
  meter.style.setProperty('--level', level.toFixed(1));
  meter.setAttribute('aria-valuenow', level.toFixed(0));
  $('happy').textContent = `${level.toFixed(0)}%`;

  const panel = meter.closest('.meter-panel');
  const state = level >= SMILE_THRESHOLD ? 'cracked' : level >= NEUTRAL_LIMIT ? 'wobbling' : 'steady';
  if (panel.dataset.state !== state) {
    panel.dataset.state = state;
    $('meter-word').textContent = { steady: 'Stone cold', wobbling: 'Wobbling…', cracked: 'Cracked!' }[state];
  }
}

function handleFace(face) {
  if (!face) return;

  for (const blink of face.blinking ?? []) {
    if (blink.detected && !wasBlinking) {
      results.blinks += 1;
      markFirst('blink');
    }
    wasBlinking = Boolean(blink.detected);
  }
  if (face.blinking?.length) $('blinks').textContent = String(results.blinks);

  const talking = face.talking?.at(-1);
  if (talking) $('talking').textContent = talking.detected ? 'Yes' : 'No';

  const expression = face.expression?.at(-1);
  if (!expression?.scores?.length) return;

  markFirst('expression');
  const now = performance.now();
  expressionTimes.push(now);
  expressionTimes = expressionTimes.filter((t) => now - t <= 5000);
  results.expressionUpdatesPerSec = Number((expressionTimes.length / 5).toFixed(1));
  $('rate').textContent = `${results.expressionUpdatesPerSec}/s`;

  const scores = expression.scores.map((s) => ({ name: expressionName(s.type), value: s.confidence }));
  const top = scores.reduce((a, b) => (b.value > a.value ? b : a));
  $('top').textContent = `${EXPRESSION_BY_NAME[top.name] ?? ''} ${top.name} ${top.value.toFixed(0)}%`.trim();

  const happy = scores.find((s) => s.name === 'happy');
  if (!happy) return;
  currentHappy = happy.value;
  results.maxHappy = Math.max(results.maxHappy ?? 0, currentHappy);
  setMeter(currentHappy);

  if (smileTrial && currentHappy >= SMILE_THRESHOLD) finishSmileTrial(now);
}

function showReading(id, key, sample, unit) {
  if (!sample) return false;
  const confidence = sample.confidence ?? 0;
  if (confidence <= 0) return false;
  markFirst(`${key} (confidence above 0)`);
  results.latest[key] = { value: Number(sample.value.toFixed(1)), confidence: Math.round(confidence) };
  $(id).textContent = `${sample.value.toFixed(0)} ${unit}`;
  return true;
}

function showWarmUps() {
  const elapsed = elapsedSeconds();
  for (const key of Object.keys(WARM_UP_S)) {
    if (results.latest[key]) continue;
    const left = Math.ceil(WARM_UP_S[key] - elapsed);
    const el = $(key);
    el.replaceChildren();
    const span = document.createElement('span');
    span.className = 'muted';
    span.textContent = left > 0 ? `Warming up · ${left}s` : 'Hold still…';
    el.append(span);
  }
}

function handleMetrics(metrics) {
  markFirst('any metrics');
  handleFace(metrics.face);

  if (showReading('pulse', 'pulse', metrics.cardio?.pulseRate?.at(-1), 'bpm')) {
    const heart = $('heart');
    heart.dataset.beating = 'true';
    heart.style.setProperty('--beat', `${(60 / Math.max(40, results.latest.pulse.value)).toFixed(2)}s`);
  }
  showReading('breathing', 'breathing', metrics.breathing?.rate?.at(-1), '/min');
  const hrv = metrics.cardio?.hrv?.at(-1);
  if (hrv) showReading('hrv', 'hrv', { value: hrv.rmssd, confidence: hrv.confidence }, 'ms');
  renderReport();
}

function renderRounds() {
  const list = $('smile-results');
  list.replaceChildren();
  for (let i = 0; i < SMILE_TRIALS; i++) {
    const item = document.createElement('li');
    const lag = results.smileLagsMs[i];
    if (lag !== undefined) {
      item.dataset.done = 'true';
      item.textContent = `${lag} ms`;
    } else {
      item.textContent = String(i + 1);
      if (i === results.smileLagsMs.length && smileTrial) item.dataset.active = 'true';
    }
    list.append(item);
  }
}

function beginSmileTrial() {
  if (!sdk || smileTrial) return;
  if (results.smileLagsMs.length >= SMILE_TRIALS) return;
  if (currentHappy === null) {
    $('smile-state').textContent = 'No face reading yet. Give it a moment.';
    return;
  }
  if (currentHappy >= NEUTRAL_LIMIT) {
    $('smile-state').textContent = 'Straighten that face first, then try again.';
    return;
  }
  const timeout = setTimeout(() => {
    smileTrial = null;
    renderRounds();
    $('smile-state').textContent =
      `The meter never reached ${SMILE_THRESHOLD}%. Try a bigger smile (your peak so far: ${(results.maxHappy ?? 0).toFixed(0)}%).`;
  }, SMILE_TIMEOUT_MS);
  smileTrial = { startedAt: performance.now(), timeout };
  renderRounds();
  $('smile-state').textContent = 'Smile!';
}

function finishSmileTrial(now) {
  clearTimeout(smileTrial.timeout);
  const lag = Math.round(now - smileTrial.startedAt);
  smileTrial = null;
  results.smileLagsMs.push(lag);
  renderRounds();
  $('smile-state').textContent = results.smileLagsMs.length >= SMILE_TRIALS
    ? `Done. Typical reaction: ${median(results.smileLagsMs)} ms.`
    : 'Caught you. Relax, then go again.';
  renderReport();
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function renderReport() {
  $('report').value = JSON.stringify(
    { ...results, smileLagMedianMs: median(results.smileLagsMs) },
    null,
    2,
  );
}

function resetReadings() {
  results = newResults();
  lastBrightness = null;
  currentHappy = null;
  wasBlinking = false;
  expressionTimes = [];
  for (const id of ['blinks', 'talking', 'pulse', 'breathing', 'hrv', 'rate']) $(id).textContent = '—';
  $('happy').textContent = '—';
  $('meter-word').textContent = '';
  $('meter').style.setProperty('--level', '0');
  $('top').textContent = 'Waiting for a face';
  $('heart').dataset.beating = 'false';
  renderRounds();
}

function showError(title, detail) {
  $('error').hidden = false;
  $('error-title').textContent = title;
  $('error-detail').textContent = detail ?? '';
  results.errors.push(detail ? `${title} ${detail}` : title);
  renderReport();
}

function setStatus(status) {
  const [label, tone] = STATUS_LABELS[status] ?? [`Status ${status}`, 'busy'];
  $('status').textContent = label;
  $('status').dataset.tone = tone;
}

function setRunning(running) {
  $('start').disabled = running || !API_KEY;
  $('stop').disabled = !running;
  $('consent').hidden = running;
  $('validation').hidden = !running;
  $('viewfinder').dataset.live = String(running);
}

function describeStream(stream) {
  const track = stream.getVideoTracks()[0];
  if (!track) return null;
  const s = track.getSettings();
  return {
    label: track.label,
    width: s.width,
    height: s.height,
    frameRate: s.frameRate,
    resizeMode: s.resizeMode,
  };
}

async function start() {
  $('error').hidden = true;
  resetReadings();
  setRunning(true);
  $('validation').textContent = 'Checking your lighting…';
  $('validation').dataset.tone = 'warn';
  try {
    const light = await checkLighting();
    results.lightCheck = light === null ? null : Math.round(light);
    if (light === null || light < MIN_BRIGHTNESS) {
      showError(
        'It’s too dark for the camera to see your face.',
        light === null
          ? 'The camera sent no picture. Check that nothing covers the lens.'
          : `Brightness was ${Math.round(light)} out of 255. Turn on a light in front of you (not behind), check the lens isn’t covered, then try again.`,
      );
      setRunning(false);
      $('start').textContent = 'Try again';
      return;
    }
    $('validation').textContent = 'Starting the camera…';

    sdk = new SmartSpectraSDK({
      apiKey: API_KEY,
      requestedMetrics: [...breathingMetrics, ...cardioMetrics, ...faceMetrics],
      enableAccumulatedOutput: false,
      enableTelemetry: false,
      logLevel: DEBUG ? SmartSpectraLogLevel.kInfo : SmartSpectraLogLevel.kWarning,
    });

    sdk.on('processingStatus', (status) => {
      setStatus(status);
      if (status === ProcessingStatus.kRunning) markFirst('running');
    });
    sdk.on('validationStatus', (code, _ts, hint) => {
      const name = VALIDATION_NAMES[code] ?? `Code ${code}`;
      results.validationCounts[name] = (results.validationCounts[name] ?? 0) + 1;
      const ok = code === ValidationCode.kOk;
      const text = ok ? 'Looking good. Hold still.' : (hint || name);
      const el = $('validation');
      if (el.textContent !== text) el.textContent = text;
      el.dataset.tone = ok ? 'ok' : 'warn';
    });
    sdk.on('metrics', (buf) => {
      try {
        handleMetrics(decodeMetrics(buf));
      } catch (err) {
        console.error('Could not read metrics', err);
      }
    });
    sdk.on('error', (code, message, retryable) => {
      console.error(`SDK error ${code} (${ERROR_NAMES[code]}): ${message}; retryable=${retryable}`);
      const dark = code === SmartSpectraErrorCode.kProcessingFailed && lastBrightness !== null
        ? ` Your picture brightness was ${lastBrightness} out of 255; aim for ${MIN_BRIGHTNESS} or more.`
        : '';
      showError(
        ERROR_TITLES[code] ?? 'The SDK reported an error.',
        `Code ${code} (${ERROR_NAMES[code] ?? 'unknown'}): ${message}${dark}`,
      );
      setStatus(ProcessingStatus.kError);
    });
    sdk.on('streamAvailable', (stream) => {
      results.camera = describeStream(stream);
      console.log('camera stream', JSON.stringify(results.camera));
      renderReport();
      $('preview').srcObject = stream;
      $('preview').play().catch(() => {});
      watchBrightness();
    });

    startedAt = performance.now();
    $('smile-state').textContent = 'Wait for the meter to move, then press Space as you smile.';
    tickHandle = setInterval(() => {
      const left = Math.max(0, Math.ceil(SESSION_LIMIT_S - elapsedSeconds()));
      $('timer').textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
      showWarmUps();
      if (left === 0) stop();
    }, 500);
    await sdk.start();
  } catch (err) {
    showError('Could not start.', err.message);
    await stop();
  }
}

async function stop() {
  clearInterval(tickHandle);
  clearInterval(brightnessHandle);
  if (smileTrial) clearTimeout(smileTrial.timeout);
  smileTrial = null;
  const current = sdk;
  sdk = null;
  if (current) {
    try {
      await current.stop();
    } catch (err) {
      console.error('Stop failed', err);
    }
    try {
      current.destroy();
    } catch {
      // Already destroyed.
    }
  }
  $('preview').srcObject = null;
  $('timer').textContent = '';
  if ($('status').dataset.tone !== 'error') setStatus(ProcessingStatus.kIdle);
  setRunning(false);
  $('heart').dataset.beating = 'false';
  renderRounds();
  renderReport();
}

$('start').addEventListener('click', start);
$('stop').addEventListener('click', stop);
$('copy').addEventListener('click', () => {
  $('report').select();
  document.execCommand('copy');
  $('copy').textContent = 'Copied';
  setTimeout(() => { $('copy').textContent = 'Copy results'; }, 1500);
});
window.addEventListener('keydown', (event) => {
  if (event.code !== 'Space' || event.repeat || ['BUTTON', 'TEXTAREA', 'SUMMARY'].includes(event.target.tagName)) return;
  event.preventDefault();
  beginSmileTrial();
});
window.addEventListener('beforeunload', () => {
  if (sdk) {
    try {
      sdk.destroy();
    } catch {
      // Already destroyed.
    }
  }
});

$('no-key').hidden = Boolean(API_KEY);
setRunning(false);
renderRounds();
renderReport();
console.log(`calibration ready; key ${API_KEY ? 'present' : 'missing'}`);
