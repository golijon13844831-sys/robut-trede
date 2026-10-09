// =========================================================================
// رندر چارت کندل روی سرور (SVG → PNG با sharp)
// دیگه به اسکرین‌شات مرورگرِ باز وابسته نیستیم — تحلیل کاملاً خودکار ۲۴/7
// =========================================================================

let sharp;
try { sharp = require('sharp'); }
catch { sharp = null; }

async function renderCandleChart(candles) {
  if (!sharp) throw new Error('کتابخانه sharp نصب نیست (npm install sharp)');
  if (!candles || candles.length < 10) throw new Error('کندل کافی برای رندر نیست');

  const W = 1000, H = 600;
  const padL = 10, padR = 80, padT = 40, padB = 30;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  const hi = Math.max(...candles.map((c) => c.high));
  const lo = Math.min(...candles.map((c) => c.low));
  const span = (hi - lo) || 1;
  const y = (v) => padT + plotH * (1 - (v - lo) / span);

  const cw = plotW / candles.length;
  const bodyW = Math.max(2, cw * 0.62);

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`;
  svg += `<rect width="100%" height="100%" fill="#1a1815"/>`;

  // گرید و لیبل قیمت
  for (let i = 0; i <= 5; i++) {
    const v = lo + (span * i) / 5;
    const yy = y(v);
    svg += `<line x1="${padL}" y1="${yy}" x2="${padL + plotW}" y2="${yy}" stroke="#2a2722" stroke-width="1"/>`;
    svg += `<text x="${padL + plotW + 8}" y="${yy + 4}" fill="#8c8577" font-family="monospace" font-size="13">${v.toFixed(2)}</text>`;
  }

  // کندل‌ها
  candles.forEach((c, i) => {
    const x = padL + cw * i + cw / 2;
    const up = c.close >= c.open;
    const col = up ? '#2fa88c' : '#b2453a';
    svg += `<line x1="${x}" y1="${y(c.high)}" x2="${x}" y2="${y(c.low)}" stroke="${col}" stroke-width="1.4"/>`;
    const yO = y(c.open), yC = y(c.close);
    const top = Math.min(yO, yC);
    const h = Math.max(1.5, Math.abs(yO - yC));
    svg += `<rect x="${x - bodyW / 2}" y="${top}" width="${bodyW}" height="${h}" fill="${col}"/>`;
  });

  // خط قیمت آخر
  const last = candles[candles.length - 1];
  const ly = y(last.close);
  svg += `<line x1="${padL}" y1="${ly}" x2="${padL + plotW}" y2="${ly}" stroke="#e8c468" stroke-width="1" stroke-dasharray="5,4"/>`;
  svg += `<text x="${padL + 4}" y="${ly - 6}" fill="#e8c468" font-family="monospace" font-size="13">${last.close.toFixed(2)}</text>`;

  // لیبل زمان
  for (let i = 0; i < candles.length; i += 20) {
    const x = padL + cw * i + cw / 2;
    const d = new Date(candles[i].time * 1000);
    const lbl = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
    svg += `<text x="${x}" y="${H - 10}" fill="#524d43" font-family="monospace" font-size="12" text-anchor="middle">${lbl}</text>`;
  }

  svg += `<text x="${padL}" y="24" fill="#8c8577" font-family="monospace" font-size="15">XAUUSD - M15 (UTC)</text>`;
  svg += '</svg>';

  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  return 'data:image/png;base64,' + buf.toString('base64');
}

module.exports = { renderCandleChart };