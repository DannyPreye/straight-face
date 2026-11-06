'use strict';

// Cool Down mode: a breathing guide that starts at the player's measured
// rate and eases toward six breaths a minute, the live chest waveform drawn
// against it, and a sync score for how closely the two move together.

const TARGET_RATE = 6;
const DEFAULT_RATE = 12;
const MAX_START_RATE = 20;
const INHALE_SHARE = 0.4;   // in for 40% of each breath, out for 60%
const RAMP_SHARE = 0.6;     // reach the target over the first 60% of the round
const WAVE_WINDOW_S = 30;
const SYNC_WINDOW_S = 15;   // correlate over the last 15 seconds
const SYNC_MAX_LAG_S = 3;   // the measured trace trails the guide a little
const GRID_HZ = 10;

function createPacer(startRate, durationS) {
  const start = Math.min(MAX_START_RATE, Math.max(TARGET_RATE, startRate ?? DEFAULT_RATE));
  let cycle = 0;
  let rate = start;
  return {
    start,
    get rate() { return rate; },
    // Advance by dt seconds at round time t. Returns the guide level (0-1)
    // and whether the player should be breathing in.
    step(t, dt) {
      const k = Math.min(1, t / (durationS * RAMP_SHARE));
      rate = start + (TARGET_RATE - start) * k;
      cycle += (dt * rate) / 60;
      const frac = cycle % 1;
      const inhaling = frac < INHALE_SHARE;
      const p = inhaling ? frac / INHALE_SHARE : (frac - INHALE_SHARE) / (1 - INHALE_SHARE);
      const ease = 0.5 - 0.5 * Math.cos(Math.PI * p);
      const period = 60 / rate;
      const leftInPhase = inhaling ? (INHALE_SHARE - frac) * period : (1 - frac) * period;
      return { level: inhaling ? ease : 1 - ease, inhaling, leftInPhase, period };
    },
  };
}

// Linear interpolation of a time series onto time t (null if out of range).
function sampleAt(series, t) {
  if (!series.length || t < series[0].t || t > series[series.length - 1].t) return null;
  let lo = 0;
  let hi = series.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (series[mid].t <= t) lo = mid; else hi = mid;
  }
  const a = series[lo];
  const b = series[hi];
  if (b.t === a.t) return a.v;
  return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
}

function zscore(xs) {
  const n = xs.length;
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / n) || 1;
  return xs.map((x) => (x - mean) / sd);
}

// Peak correlation (0-100) between the guide and the measured trace over the
// last SYNC_WINDOW_S seconds, allowing the trace to lag by up to 3 seconds.
// The trace's sign isn't documented, so either direction counts as in sync.
// Returns null when there isn't enough of both signals yet.
function syncScore(guide, trace, now) {
  const from = now - SYNC_WINDOW_S;
  const n = SYNC_WINDOW_S * GRID_HZ;
  const traceVals = [];
  for (let i = 0; i < n; i++) {
    const v = sampleAt(trace, from + i / GRID_HZ);
    if (v === null) return null;
    traceVals.push(v);
  }
  const tz = zscore(traceVals);
  let best = null;
  for (let lag = 0; lag <= SYNC_MAX_LAG_S * GRID_HZ; lag++) {
    const g = [];
    for (let i = 0; i < n; i++) {
      const v = sampleAt(guide, from + (i - lag) / GRID_HZ);
      if (v === null) break;
      g.push(v);
    }
    if (g.length < n) continue;
    const gz = zscore(g);
    let r = 0;
    for (let i = 0; i < n; i++) r += gz[i] * tz[i];
    best = Math.max(best ?? 0, Math.abs(r / n));
  }
  // No lag had a full window of guide yet: not ready, rather than 0%.
  return best === null ? null : Math.round(best * 100);
}

function drawWave(canvas, guide, trace, now) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const pad = 14;
  ctx.clearRect(0, 0, w, h);
  const x = (t) => w - ((now - t) / WAVE_WINDOW_S) * w;
  const y = (v) => h - pad - v * (h - pad * 2);

  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(255, 201, 60, .8)';
  ctx.beginPath();
  guide.filter((g) => g.t >= now - WAVE_WINDOW_S).forEach((g, i) => {
    if (i === 0) ctx.moveTo(x(g.t), y(g.v)); else ctx.lineTo(x(g.t), y(g.v));
  });
  ctx.stroke();

  const pts = trace.filter((p) => p.t >= now - WAVE_WINDOW_S);
  if (pts.length < 3) return false;
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of pts) { lo = Math.min(lo, p.v); hi = Math.max(hi, p.v); }
  const span = hi - lo || 1;
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#4fe0b0';
  ctx.beginPath();
  pts.forEach((p, i) => {
    // Light 5-point moving average: camera breathing traces are noisy.
    let sum = 0;
    let k = 0;
    for (let j = Math.max(0, i - 2); j <= Math.min(pts.length - 1, i + 2); j++) { sum += pts[j].v; k++; }
    const yy = y((sum / k - lo) / span);
    if (i === 0) ctx.moveTo(x(p.t), yy); else ctx.lineTo(x(p.t), yy);
  });
  ctx.stroke();
  return true;
}

module.exports = { createPacer, syncScore, drawWave, WAVE_WINDOW_S, TARGET_RATE, DEFAULT_RATE };
