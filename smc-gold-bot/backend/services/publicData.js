// =========================================================================
// منبع داده عمومی رایگان (Yahoo Finance) — بدون نیاز به کلید API
// وقتی سیستم خونه (و MT5) خاموشه، قیمت و کندل از این‌جا میاد.
// نکته: قیمت این منبع اسپات جهانیه و ممکنه چند ده‌سنت با بروکرت فرق کنه.
// =========================================================================
const YF_BASE = 'https://query1.finance.yahoo.com';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };

// نماد طلا: GC=F (Gold Futures) — XAUUSD=X دیگه کار نمی‌کنه
const SYMBOL = 'GC=F';

const TF_MAP = {
  M5:  { interval: '5m',  range: '3d' },
  M15: { interval: '15m', range: '5d' },
  H1:  { interval: '1h',  range: '15d' },
  D1:  { interval: '1d',  range: '30d' },
};
const CACHE_TTL_MS = 60 * 1000;
const cache = new Map();

async function fetchCandles(timeframe, count) {
  const cfg = TF_MAP[timeframe];
  if (!cfg) throw new Error(`تایم‌فریم ${timeframe} پشتیبانی نمی‌شود`);

  const hit = cache.get(timeframe);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit.candles.slice(-count);
  }

  const res = await fetch(
    `${YF_BASE}/v8/finance/chart/${SYMBOL}?interval=${cfg.interval}&range=${cfg.range}`,
    { headers: HEADERS }
  );
  if (!res.ok) throw new Error(`منبع عمومی خطا داد (${res.status})`);

  const json = await res.json();
  const r = json?.chart?.result?.[0];
  const ts = r?.timestamp || [];
  const q = r?.indicators?.quote?.[0] || {};
  const candles = [];

  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    candles.push({ time: ts[i], open: o, high: h, low: l, close: c });
  }

  if (!candles.length) throw new Error('منبع عمومی کندل برنگرداند');
  cache.set(timeframe, { at: Date.now(), candles });
  return candles.slice(-count);
}

async function getPrice() {
  const c = await fetchCandles('M5', 2);
  return c[c.length - 1].close;
}

module.exports = { getCandles: fetchCandles, getPrice };
