'use strict';

// One SmartSpectra session for the whole app. It owns the camera, runs
// a lighting check before the SDK starts, and turns raw metrics into simple
// events the game can react to. Nothing here stores or sends readings.

const {
  SmartSpectraSDK,
  ProcessingStatus,
  ValidationCode,
  SmartSpectraErrorCode,
  breathingMetrics,
  cardioMetrics,
  faceMetrics,
} = require('@smartspectra/node-sdk/renderer');
const { decodeMetrics } = require('@smartspectra/node-sdk/messages');

// Average brightness on a 0-255 scale. Below this the face is too dark for
// the SDK to read. A webcam frame in an unlit room measured about 7.
const MIN_BRIGHTNESS = 40;
const LIGHT_CHECK_MS = 1500;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1500;

const EXPRESSION_NAMES = {
  1: 'angry', 2: 'contempt', 3: 'disgust', 4: 'fear',
  5: 'happy', 6: 'neutral', 7: 'sad', 8: 'surprise',
};
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
  [SmartSpectraErrorCode.kProcessingFailed]: 'The SDK stopped reading your camera. This usually means the connection to Presage dropped, or the picture is too dark.',
  [SmartSpectraErrorCode.kFrameConversionFailed]: 'The SDK could not read your camera’s video format.',
};
// Codes where the face can't be read, so a round shouldn't count.
const FACE_LOST = new Set([
  ValidationCode.kNoFaceFound,
  ValidationCode.kMultipleFacesFound,
  ValidationCode.kFaceNotForward,
].filter((v) => v !== undefined));

function tsToNumber(ts) {
  if (ts == null) return 0;
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'bigint') return Number(ts);
  if (typeof ts.toNumber === 'function') return ts.toNumber();
  return Number(ts);
}

class Session extends EventTarget {
  constructor({ apiKey, debug = false }) {
    super();
    this.apiKey = apiKey;
    this.debug = debug;
    this.sdk = null;
    this.video = null;
    this.startedAt = 0;
    this.sampler = document.createElement('canvas');
    this.sampler.width = 64;
    this.sampler.height = 36;
    this.samplerCtx = this.sampler.getContext('2d', { willReadFrequently: true });
    this.brightnessHandle = null;
    this.retries = 0;
    this.reset();
  }

  reset() {
    this.happy = null;
    this.top = null;
    this.blinks = 0;
    this.wasBlinking = false;
    this.faceOk = false;
    this.vitals = { pulse: null, breathing: null, hrv: null };
    this.brightness = null;
    this.camera = null;
    this.lightCheck = null;
  }

  get running() {
    return this.sdk !== null;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  elapsedSeconds() {
    return this.startedAt ? (performance.now() - this.startedAt) / 1000 : 0;
  }

  // Mean luma of a downscaled frame, or null until the video has a frame.
  measureBrightness(video) {
    if (!video || video.readyState < 2) return null;
    this.samplerCtx.drawImage(video, 0, 0, this.sampler.width, this.sampler.height);
    const { data } = this.samplerCtx.getImageData(0, 0, this.sampler.width, this.sampler.height);
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    return sum / (data.length / 4);
  }

  // Opens the camera briefly, lets auto-exposure settle, and returns the
  // brightest reading. The camera is released before the SDK takes it.
  async checkLighting() {
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
        const value = this.measureBrightness(video);
        if (value !== null) best = Math.max(best ?? 0, value);
      }
      return best;
    } finally {
      for (const track of stream.getTracks()) track.stop();
      video.srcObject = null;
    }
  }

  // Returns { ok: true } or { ok: false, reason, title, detail }.
  // A restart after a dropped connection skips the lighting check.
  async start(video, { recovering = false } = {}) {
    if (this.sdk) return { ok: true };
    this.video = video;
    this.reset();
    if (!recovering) this.retries = 0;
    this.emit('status', { label: recovering ? 'Reconnecting' : 'Checking light', tone: 'busy' });

    let light = MIN_BRIGHTNESS;
    try {
      if (!recovering) light = await this.checkLighting();
    } catch (err) {
      this.emit('status', { label: 'Camera off', tone: 'idle' });
      return { ok: false, reason: 'camera', title: 'The camera could not be opened.', detail: err.message };
    }
    if (!recovering) this.lightCheck = light === null ? null : Math.round(light);
    if (light === null || light < MIN_BRIGHTNESS) {
      this.emit('status', { label: 'Camera off', tone: 'idle' });
      return {
        ok: false,
        reason: 'dark',
        title: 'It’s too dark for the camera to see your face.',
        detail: light === null
          ? 'The camera sent no picture. Check that nothing covers the lens.'
          : `Brightness was ${Math.round(light)} out of 255. Turn on a light in front of you (not behind), check the lens isn’t covered, then try again.`,
      };
    }

    const sdk = new SmartSpectraSDK({
      apiKey: this.apiKey,
      requestedMetrics: [...breathingMetrics, ...cardioMetrics, ...faceMetrics],
      enableAccumulatedOutput: false,
      enableTelemetry: false,
    });
    this.sdk = sdk;

    sdk.on('processingStatus', (status) => {
      const [label, tone] = STATUS_LABELS[status] ?? [`Status ${status}`, 'busy'];
      this.emit('status', { label, tone, running: status === ProcessingStatus.kRunning });
    });
    sdk.on('validationStatus', (code, _ts, hint) => {
      const ok = code === ValidationCode.kOk;
      this.faceOk = !FACE_LOST.has(code);
      this.emit('validation', {
        ok,
        faceLost: FACE_LOST.has(code),
        name: VALIDATION_NAMES[code] ?? `Code ${code}`,
        text: ok ? 'Looking good. Hold still.' : (hint || VALIDATION_NAMES[code]),
      });
    });
    sdk.on('metrics', (buf) => {
      try {
        this.handleMetrics(decodeMetrics(buf));
      } catch (err) {
        console.error('Could not read metrics', err);
      }
    });
    sdk.on('error', (code, message, retryable) => {
      console.error(`SDK error ${code} (${ERROR_NAMES[code]}): ${message}; retryable=${retryable}`);
      // The SDK fetches models and checks usage with Presage's servers while
      // it runs, so a network blip can end a session. Reconnect quietly.
      if (retryable && this.retries < MAX_RETRIES && this.sdk === sdk) {
        this.retries += 1;
        this.emit('recovering', { attempt: this.retries, code });
        this.recover();
        return;
      }
      const dark = code === SmartSpectraErrorCode.kProcessingFailed && this.brightness !== null
        ? ` Your picture brightness was ${this.brightness} out of 255; aim for ${MIN_BRIGHTNESS} or more.`
        : '';
      this.emit('error', {
        code,
        title: ERROR_TITLES[code] ?? 'The SDK reported an error.',
        detail: `Code ${code} (${ERROR_NAMES[code] ?? 'unknown'}): ${message}${dark}`,
      });
      this.emit('status', { label: 'Error', tone: 'error' });
    });
    sdk.on('streamAvailable', (stream) => {
      const track = stream.getVideoTracks()[0];
      if (track) {
        const s = track.getSettings();
        this.camera = { label: track.label, width: s.width, height: s.height, frameRate: s.frameRate };
      }
      this.video.srcObject = stream;
      this.video.play().catch(() => {});
      this.watchBrightness();
      this.emit('stream', { camera: this.camera });
    });

    this.startedAt = performance.now();
    try {
      await sdk.start();
    } catch (err) {
      await this.stop();
      return { ok: false, reason: 'sdk', title: 'Could not start the SDK.', detail: err.message };
    }
    return { ok: true };
  }

  async recover() {
    const video = this.video;
    await this.stop();
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    const res = await this.start(video, { recovering: true });
    if (res.ok) {
      this.emit('recovered', {});
    } else {
      this.emit('error', { code: null, title: res.title, detail: res.detail });
    }
  }

  watchBrightness() {
    clearInterval(this.brightnessHandle);
    this.brightnessHandle = setInterval(() => {
      const value = this.measureBrightness(this.video);
      if (value === null) return;
      this.brightness = Math.round(value);
      if (value < MIN_BRIGHTNESS) this.emit('dark', { brightness: this.brightness });
    }, 1000);
  }

  handleMetrics(metrics) {
    const face = metrics.face;
    if (face) {
      for (const blink of face.blinking ?? []) {
        if (blink.detected && !this.wasBlinking) {
          this.blinks += 1;
          this.emit('blink', { count: this.blinks, at: performance.now() });
        }
        this.wasBlinking = Boolean(blink.detected);
      }
      const talking = face.talking?.at(-1);
      if (talking) this.emit('talking', { detected: Boolean(talking.detected) });

      const expression = face.expression?.at(-1);
      if (expression?.scores?.length) {
        const scores = expression.scores.map((s) => ({
          name: typeof s.type === 'number' ? EXPRESSION_NAMES[s.type] : String(s.type).toLowerCase(),
          value: s.confidence,
        }));
        this.top = scores.reduce((a, b) => (b.value > a.value ? b : a));
        this.happy = scores.find((s) => s.name === 'happy')?.value ?? this.happy;
        this.emit('expression', { happy: this.happy, top: this.top, at: performance.now() });
      }
    }

    // Chest-movement waveform. Each event carries only the samples since the
    // last one, so listeners append. Timestamps are microseconds since epoch.
    const trace = metrics.breathing?.upperTrace ?? [];
    if (trace.length) {
      this.emit('breathTrace', {
        points: trace.map((m) => ({ t: tsToNumber(m.timestamp) / 1e6, v: m.value })),
      });
    }

    const pick = (sample) => (sample && (sample.confidence ?? 0) > 0
      ? { value: sample.value, confidence: sample.confidence }
      : null);
    const pulse = pick(metrics.cardio?.pulseRate?.at(-1));
    const breathing = pick(metrics.breathing?.rate?.at(-1));
    const hrvRaw = metrics.cardio?.hrv?.at(-1);
    const hrv = hrvRaw ? pick({ value: hrvRaw.rmssd, confidence: hrvRaw.confidence }) : null;
    let changed = false;
    for (const [key, value] of Object.entries({ pulse, breathing, hrv })) {
      if (value) {
        this.vitals[key] = value;
        changed = true;
      }
    }
    if (changed) this.emit('vitals', { ...this.vitals });
  }

  // Grabs the current preview frame, mirrored like the on-screen preview.
  snapshot() {
    const video = this.video;
    if (!video || video.readyState < 2) return null;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0);
    return canvas;
  }

  async stop() {
    clearInterval(this.brightnessHandle);
    const sdk = this.sdk;
    this.sdk = null;
    this.startedAt = 0;
    if (sdk) {
      try {
        await sdk.stop();
      } catch (err) {
        console.error('Stop failed', err);
      }
      try {
        sdk.destroy();
      } catch {
        // Already destroyed.
      }
    }
    if (this.video) this.video.srcObject = null;
    this.emit('status', { label: 'Camera off', tone: 'idle' });
    this.emit('stopped', {});
  }

  destroy() {
    if (this.sdk) {
      try {
        this.sdk.destroy();
      } catch {
        // Already destroyed.
      }
    }
  }
}

module.exports = { Session, MIN_BRIGHTNESS, tsToNumber };
