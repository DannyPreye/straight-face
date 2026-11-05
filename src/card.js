'use strict';

// Builds the shareable result card. The photo only exists in memory: the
// card is a canvas, and a file is written only if the player clicks Save.

const W = 1080;
const H = 1350;
const COLORS = {
  bg: '#120f1f',
  bg2: '#201a38',
  ink: '#fbf6ec',
  dim: '#b8afcf',
  sun: '#ffc93c',
  coral: '#ff6b5b',
  mint: '#4fe0b0',
};

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrap(ctx, text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawLogo(ctx, x, y, size) {
  const r = size / 2;
  ctx.fillStyle = COLORS.sun;
  ctx.beginPath();
  ctx.arc(x + r, y + r, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = COLORS.bg;
  ctx.beginPath();
  ctx.arc(x + r * 0.69, y + r * 0.83, r * 0.125, 0, Math.PI * 2);
  ctx.arc(x + r * 1.31, y + r * 0.83, r * 0.125, 0, Math.PI * 2);
  ctx.fill();
  roundRect(ctx, x + r * 0.58, y + r * 1.27, r * 0.84, r * 0.15, r * 0.075);
  ctx.fill();
}

// Crop the source to fill the target box, like CSS object-fit: cover.
function drawCover(ctx, src, x, y, w, h) {
  const scale = Math.max(w / src.width, h / src.height);
  const sw = w / scale;
  const sh = h / scale;
  ctx.drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, x, y, w, h);
}

/**
 * @param {object} o
 * @param {HTMLCanvasElement|null} o.photo
 * @param {'cracked'|'blinked'|'unbreakable'} o.outcome
 * @param {number} o.seconds
 * @param {string} o.player
 * @param {string} o.modeLabel
 * @param {[string, string]|null} o.prompt  emoji + text that was on screen
 */
async function renderCard({ photo, outcome, seconds, player, modeLabel, prompt }) {
  await Promise.all([
    document.fonts.load('800 80px "Bricolage Grotesque Variable"'),
    document.fonts.load('600 30px "Inter Variable"'),
  ]).catch(() => {});

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, COLORS.bg2);
  bg.addColorStop(1, COLORS.bg);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const accent = outcome === 'unbreakable' ? COLORS.mint : outcome === 'blinked' ? COLORS.sun : COLORS.coral;

  // Photo, or a big face if the player kept photos off.
  const px = 70;
  const py = 70;
  const pw = W - 140;
  const ph = 760;
  ctx.save();
  roundRect(ctx, px, py, pw, ph, 44);
  ctx.clip();
  if (photo) {
    drawCover(ctx, photo, px, py, pw, ph);
  } else {
    ctx.fillStyle = '#0b0915';
    ctx.fillRect(px, py, pw, ph);
    drawLogo(ctx, W / 2 - 160, py + ph / 2 - 160, 320);
  }
  ctx.restore();
  ctx.lineWidth = 10;
  ctx.strokeStyle = accent;
  roundRect(ctx, px, py, pw, ph, 44);
  ctx.stroke();

  // Stamp.
  const stamp = { cracked: 'CRACKED', blinked: 'BLINKED', unbreakable: 'UNBREAKABLE' }[outcome];
  ctx.save();
  ctx.translate(W - 250, py + 110);
  ctx.rotate(-0.12);
  ctx.font = '800 64px "Bricolage Grotesque Variable", sans-serif';
  const sw = ctx.measureText(stamp).width + 60;
  ctx.fillStyle = accent;
  roundRect(ctx, -sw / 2, -50, sw, 100, 22);
  ctx.fill();
  ctx.fillStyle = COLORS.bg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(stamp, 0, 4);
  ctx.restore();

  // Score.
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = COLORS.ink;
  ctx.font = '800 150px "Bricolage Grotesque Variable", sans-serif';
  ctx.fillText(`${seconds.toFixed(1)}s`, 70, 1000);

  ctx.font = '700 44px "Bricolage Grotesque Variable", sans-serif';
  ctx.fillStyle = accent;
  ctx.fillText(player, 70, 1065);
  ctx.font = '600 32px "Inter Variable", sans-serif';
  ctx.fillStyle = COLORS.dim;
  ctx.fillText(modeLabel, 70 + ctx.measureText(' ').width + measureBold(ctx, player), 1065);

  if (prompt) {
    ctx.font = '600 34px "Inter Variable", sans-serif';
    ctx.fillStyle = COLORS.ink;
    const lines = wrap(ctx, `${prompt[0]}  ${prompt[1]}`, W - 140).slice(0, 3);
    lines.forEach((l, i) => ctx.fillText(l, 70, 1140 + i * 48));
  }

  drawLogo(ctx, 70, H - 105, 56);
  ctx.font = '800 36px "Bricolage Grotesque Variable", sans-serif';
  ctx.fillStyle = COLORS.ink;
  ctx.fillText('Straight Face', 142, H - 64);

  return canvas;
}

// Width of the player name in the heavier font, for laying out the mode label.
function measureBold(ctx, text) {
  const saved = ctx.font;
  ctx.font = '700 44px "Bricolage Grotesque Variable", sans-serif';
  const width = ctx.measureText(`${text}  `).width;
  ctx.font = saved;
  return width;
}

module.exports = { renderCard };
