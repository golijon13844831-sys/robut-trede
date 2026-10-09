// ---------------------------------------------------------------------------
// سرور اصلی — نسخه مستقل: تحلیل ۲۴/7 حتی وقتی سیستم خونه خاموشه
// ---------------------------------------------------------------------------
require('dotenv').config();

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const bridge = require('./services/bridge');
const publicData = require('./services/publicData');
const chartRender = require('./services/chartRender');
const { analyzeChart, predictBigMove, setLogger: setGeminiLogger, getKeysStatus } = require('./services/gemini');
const { validateSignal } = require('./services/riskValidator');

const PORT = process.env.PORT || 3000;
const ACCOUNT_POLL_MS = Number(process.env.ACCOUNT_POLL_MS || 5000);
const CANDLES_REFRESH_MS = 15000;
const ANALYSIS_INTERVAL_MS = Number(process.env.ANALYSIS_INTERVAL_MS || 300000);
const MANAGEMENT_POLL_MS = 5000;
const PERF_POLL_MS = 30000;
const SIGNAL_TTL_MS = 3 * 60 * 1000;
const MAX_DAILY_SIGNALS = Number(process.env.MAX_DAILY_SIGNALS || 20);
const CONFIDENCE_THRESHOLD = Number(process.env.CONFIDENCE_THRESHOLD || 0.8);
const MAX_SPREAD = Number(process.env.MAX_SPREAD || 0.6);
const AUTO_START = (process.env.AUTO_START || 'false').toLowerCase() === 'true';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ثبت آدرس تانل توسط پل داخل خونه (وقتی سیستم روشن میشه خودش وصل میشه)
app.post('/register-bridge', (req, res) => {
  if (req.get('X-API-Key') !== (process.env.BRIDGE_API_KEY || '')) {
    return res.status(401).json({ ok: false });
  }
  const url = req.body?.url;
  if (typeof url !== 'string' || !/^https:\/\/[a-zA-Z0-9.-]+\/?$/.test(url)) {
    return res.status(400).json({ ok: false });
  }
  bridge.setBridgeUrl(url);
  state.bridgeAlive = true;
  io.emit('data-source', 'bridge');
  log(`🔄 سیستم خونه وصل شد؛ آدرس پل: ${url}`);
  res.json({ ok: true });
});

const state = {
  botActive: false,
  bridgeAlive: true, // تا اولین خطا فرض بر وصل بودن
  settings: {
    mode: 'manual',        // 'manual' | 'auto' | 'signal'
    volume: 0.10,
    riskSizing: true,
    riskPercent: 1.0,
    maxPositions: 1,
    dailyLossLimitPct: 4,
    cooldownMinutes: 20,
    breakEven: true,
    trailing: false,
    trailStartR: 1.5,
    trailDistance: 1.5,
  },
  lastFrames: { M15: null },   // فقط پشتیبان (اگه sharp نبود)
  lastTick: null,
  lastPrice: null,
  lastEquity: null,
  activeSignal: null,
  lastSignal: null,            // آخرین سیگنال برای نمایش به کاربرِ بعداً وصل‌شده
  lastPrediction: null,        // آخرین پیش‌بینی برای همین هدف
  accountTimer: null,
  candlesTimer: null,
  analysisTimer: null,
  managementTimer: null,
  perfTimer: null,
  revivalTimer: null,
  cooldownUntil: 0,
  dailyLocked: false,
  dailySignalDate: null,
  dailySignalCount: 0,
  dayStartEquity: null,
  candlesCache: [],
  m5CandlesCache: [],
  h1CandlesCache: [],
  adr: null,
  todayOpen: null,
  contextRefreshedAt: 0,
  positionMeta: {},
  predictionBusy: false,
};

const mapCandle = (c) => ({
  time: Math.floor(new Date(c.time).getTime() / 1000),
  open: c.open, high: c.high, low: c.low, close: c.close,
});

function log(message) {
  const time = new Date().toLocaleTimeString('fa-IR');
  console.log(`[${time}] ${message}`);
  io.emit('new-log', { time, message });
}
setGeminiLogger(log);

function emitKeyStatus() { io.emit('gemini-keys', getKeysStatus()); }
function emitSettings() { io.emit('settings', state.settings); }
function emitDailyStats() { io.emit('daily-stats', { count: state.dailySignalCount, max: MAX_DAILY_SIGNALS }); }

function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function markBridgeDown(err) {
  if (!state.bridgeAlive) return;
  state.bridgeAlive = false;
  log(`⚠️ سیستم خونه در دسترس نیست (${err.message}) — سوییچ به داده عمومی.`);
  io.emit('data-source', 'public');
  io.emit('alert', { level: 'danger', message: 'اتصال به سیستم معاملاتی قطع شد؛ سایت با داده عمومی ادامه میده (تحلیل کار می‌کنه، معامله نه).' });
}

function resetDailyCounterIfNeeded() {
  const today = new Date().toDateString();
  if (state.dailySignalDate !== today) {
    state.dailySignalDate = today;
    state.dailySignalCount = 0;
    state.dailyLocked = false;
    state.dayStartEquity = state.lastEquity;
    state.positionMeta = {};
    emitDailyStats();
  }
  if (state.dayStartEquity === null && state.lastEquity !== null) {
    state.dayStartEquity = state.lastEquity;
  }
}

function checkDailyGuard() {
  const s = state.settings;
  if (state.dailyLocked || !s.dailyLossLimitPct || !state.dayStartEquity || !state.lastEquity) return;
  const ddPct = ((state.dayStartEquity - state.lastEquity) / state.dayStartEquity) * 100;
  if (ddPct >= s.dailyLossLimitPct) {
    state.dailyLocked = true;
    if (s.mode === 'auto') s.mode = 'manual';
    emitSettings();
    log(`⛔ حد ضرر روزانه فعال شد (افت ${ddPct.toFixed(2)}٪). ورود جدید تا فردا مسدود است.`);
    io.emit('alert', { level: 'danger', message: `حد ضرر روزانه (${s.dailyLossLimitPct}٪) فعال شد؛ ورود جدید تا فردا مسدود است.` });
  }
}

// ---------------------------------------------------------------------------
// مسیریابی داده: اول بریج خونه، اگه نبود منبع عمومی
// ---------------------------------------------------------------------------
async function getTf(timeframe, count) {
  if (state.bridgeAlive) {
    try {
      return (await bridge.getCandles(timeframe, count)).map(mapCandle);
    } catch (err) {
      markBridgeDown(err);
    }
  }
  return publicData.getCandles(timeframe, count);
}

async function refreshCandles() {
  try { state.candlesCache = await getTf('M15', 200); }
  catch (err) { log(`خطا در کندل M15: ${err.message}`); }
  try { state.m5CandlesCache = await getTf('M5', 60); }
  catch (err) { log(`خطا در کندل M5: ${err.message}`); }
}

async function refreshAnalysisContext() {
  try {
    const [h1, d1] = await Promise.all([getTf('H1', 60), getTf('D1', 14)]);
    state.h1CandlesCache = h1;
    const ranges = d1.slice(-11, -1).map((c) => c.high - c.low);
    if (ranges.length) state.adr = ranges.reduce((a, b) => a + b, 0) / ranges.length;
    if (d1.length) state.todayOpen = d1[d1.length - 1].open;
    state.contextRefreshedAt = Date.now();
  } catch (err) {
    log(`خطا در کانتکست تحلیل: ${err.message}`);
  }
}

function getSessionName() {
  const h = new Date().getUTCHours() + new Date().getUTCMinutes() / 60;
  if (h >= 12.5 && h < 16) return 'نیویورک (Kill Zone)';
  if (h >= 7 && h < 11) return 'لندن (Kill Zone)';
  if (h >= 0 && h < 5) return 'آسیا';
  return 'خارج از کیل‌زون‌های اصلی';
}

async function pollData() {
  if (state.bridgeAlive) {
    try {
      const [account, priceData, positions] = await Promise.all([
        bridge.getAccount(), bridge.getPrice(), bridge.getPositions(),
      ]);
      state.lastTick = { bid: priceData.bid, ask: priceData.ask };
      state.lastPrice = priceData.ask;
      state.lastEquity = account.equity;
      checkDailyGuard();
      io.emit('account-update', {
        balance: account.balance, equity: account.equity, freeMargin: account.free_margin,
        bid: priceData.bid, ask: priceData.ask, positions,
        candles: state.candlesCache, source: 'bridge',
      });
      return;
    } catch (err) {
      markBridgeDown(err);
    }
  }

  // حالت داده عمومی (سیستم خونه خاموش)
  try {
    const price = await publicData.getPrice();
    state.lastPrice = price;
    state.lastTick = null;
    io.emit('account-update', {
      balance: null, equity: null, freeMargin: null,
      bid: price, ask: price, positions: [],
      candles: state.candlesCache, source: 'public',
    });
  } catch (err) {
    log(`خطا در داده عمومی: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// تحلیل دوره‌ای — با چارت رندرشده روی سرور
// ---------------------------------------------------------------------------
async function buildChartImage() {
  try {
    return await chartRender.renderCandleChart(state.candlesCache.slice(-120));
  } catch (err) {
    if (state.lastFrames.M15) return state.lastFrames.M15; // پشتیبان: اسکرین‌شات مرورگر
    throw err;
  }
}

async function runAnalysis() {
  resetDailyCounterIfNeeded();
  if (!state.candlesCache.length || !state.m5CandlesCache.length) return;

  if (state.dailySignalCount >= MAX_DAILY_SIGNALS) return;

  try {
    const imageDataUrl = await buildChartImage();
    const raw = await analyzeChart(imageDataUrl, state.lastPrice, state.m5CandlesCache, {
      h1Candles: state.h1CandlesCache,
      adr: state.adr,
      todayOpen: state.todayOpen,
      session: getSessionName(),
      utcTime: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
    });

    let validated = validateSignal(raw, state.lastPrice);
    if (['buy', 'sell'].includes(validated.direction) && validated.confidence < CONFIDENCE_THRESHOLD) {
      validated = {
        ...validated,
        direction: 'wait',
        reason: `اطمینان (${Math.round(validated.confidence * 100)}٪) زیر آستانه ${Math.round(CONFIDENCE_THRESHOLD * 100)}٪ بود.`,
      };
    }

    const signal = { id: Date.now().toString(), expiresAt: Date.now() + SIGNAL_TTL_MS, ...validated };
    state.lastSignal = signal;
    const isTradeable = ['buy', 'sell'].includes(signal.direction);

    if (isTradeable) {
      state.dailySignalCount += 1;
      emitDailyStats();
    }

    if (isTradeable && state.settings.mode === 'auto' && state.bridgeAlive) {
      state.activeSignal = null;
      io.emit('signal', { ...signal, auto: true });
      log(`🤖 سیگنال خودران: ${signal.direction.toUpperCase()} (${Math.round(signal.confidence * 100)}٪)`);
      await autoExecute(signal);
    } else if (isTradeable && state.settings.mode === 'signal') {
      state.activeSignal = null;
      io.emit('signal', { ...signal, signalOnly: true });
      log(`📊 ستاپ: ${signal.direction.toUpperCase()} (${Math.round(signal.confidence * 100)}٪) — فقط نمایش.`);
    } else if (isTradeable) {
      state.activeSignal = signal;
      io.emit('signal', signal);
      log(`🔔 سیگنال: ${signal.direction.toUpperCase()} (${Math.round(signal.confidence * 100)}٪) — منتظر تأیید.`);
    } else {
      state.activeSignal = null;
      io.emit('signal', signal);
      log(`تحلیل جدید: بدون سیگنال معتبر. ${signal.reason || ''}`);
    }
  } catch (err) {
    log(`خطا در تحلیل Gemini: ${err.message}`);
  }
  emitKeyStatus();
}

// ---------------------------------------------------------------------------
// اجرای معامله (فقط وقتی بریج زنده‌ست)
// ---------------------------------------------------------------------------
async function autoExecute(signal) {
  if (state.settings.mode !== 'auto') return;
  if (!state.bridgeAlive) { log('⛔ سیستم خونه خاموش است؛ اجرای معامله ممکن نیست.'); return; }

  const s = state.settings;
  if (state.dailyLocked) { log('⛔ ورود جدید مسدود است (حد ضرر روزانه).'); return; }
  if (Date.now() < state.cooldownUntil) {
    log(`⏳ فاصله بین معاملات هنوز پر نشده (${Math.ceil((state.cooldownUntil - Date.now()) / 60000)} دقیقه مانده).`);
    return;
  }
  if (state.lastTick) {
    const spread = state.lastTick.ask - state.lastTick.bid;
    if (spread > MAX_SPREAD) { log(`اسپرد بالا (${spread.toFixed(2)}$)؛ اجرا متوقف شد.`); return; }
  }

  let positions = [];
  try { positions = await bridge.getPositions(); }
  catch (err) { log(`دریافت پوزیشن‌ها ناموفق: ${err.message}`); return; }
  if (positions.length >= s.maxPositions) {
    log(`سقف پوزیشن همزمان (${s.maxPositions}) پر است.`);
    return;
  }

  await executeSignal(signal, await computeLot(signal));
}

async function computeLot(signal) {
  const s = state.settings;
  if (!s.riskSizing) return s.volume;
  try {
    const [account, info] = await Promise.all([bridge.getAccount(), bridge.getSymbolInfo()]);
    const entry = signal.entry || state.lastTick?.ask || 0;
    const slDist = Math.abs(entry - signal.stop_loss);
    if (!slDist || !info.tick_value || !info.tick_size) return s.volume;
    const valuePerDollarPerLot = info.tick_value / info.tick_size;
    const riskAmount = account.balance * (s.riskPercent / 100);
    let lot = riskAmount / (slDist * valuePerDollarPerLot);
    const step = info.volume_step || 0.01;
    lot = Math.floor(lot / step) * step;
    lot = Math.max(info.volume_min || 0.01, Math.min(info.volume_max || 100, lot));
    return Number(lot.toFixed(2));
  } catch {
    return s.volume;
  }
}

async function executeSignal(signal, volume) {
  try {
    const result = await bridge.placeOrder({
      direction: signal.direction, volume,
      stop_loss: signal.stop_loss, take_profit: signal.take_profit,
      comment: state.settings.mode === 'auto' ? 'smc-autopilot' : 'smc-gemini-bot',
    });
    state.cooldownUntil = Date.now() + state.settings.cooldownMinutes * 60000;
    log(`✅ اجرا شد: ${signal.direction.toUpperCase()} ${volume} لات @ ${result.price} (تیکت ${result.order_id})`);
    io.emit('alert', { level: 'success', message: `معامله ${signal.direction === 'buy' ? 'خرید' : 'فروش'} ${volume} لات @ ${result.price} اجرا شد.` });
    await pollData();
  } catch (err) {
    log(`❌ اجرای سفارش ناموفق: ${err.message}`);
    io.emit('alert', { level: 'danger', message: `اجرای سفارش ناموفق: ${err.message}` });
  }
}

async function managePositions() {
  if (!state.botActive || !state.bridgeAlive || !state.lastTick) return;
  const s = state.settings;
  if (!s.breakEven && !s.trailing) return;

  let positions = [];
  try { positions = await bridge.getPositions(); }
  catch { return; }

  const live = new Set(positions.map((p) => p.id));
  for (const t of Object.keys(state.positionMeta)) {
    if (!live.has(Number(t))) delete state.positionMeta[t];
  }

  for (const p of positions) {
    if (!p.sl || p.sl <= 0) continue;
    const isBuy = p.type === 'BUY';
    const price = isBuy ? state.lastTick.bid : state.lastTick.ask;

    if (!state.positionMeta[p.id]) {
      state.positionMeta[p.id] = { initialRisk: Math.abs(p.entry - p.sl), beDone: false };
    }
    const meta = state.positionMeta[p.id];
    if (!meta.initialRisk) continue;

    const rMultiple = (isBuy ? price - p.entry : p.entry - price) / meta.initialRisk;

    if (s.breakEven && !meta.beDone && rMultiple >= 1) {
      const buffer = Math.max(meta.initialRisk * 0.05, 0.05);
      const bePrice = Number((isBuy ? p.entry + buffer : p.entry - buffer).toFixed(2));
      const needsMove = isBuy ? p.sl < p.entry : p.sl > p.entry;
      if (needsMove) {
        try {
          await bridge.modifyPosition({ ticket: p.id, stop_loss: bePrice });
          meta.beDone = true;
          log(`🛡 پوزیشن #${p.id} روی سربه‌سر قفل شد (SL → ${bePrice})`);
        } catch (err) { log(`سربه‌سركردن #${p.id} ناموفق: ${err.message}`); }
      } else meta.beDone = true;
    }

    if (s.trailing && rMultiple >= s.trailStartR) {
      const desired = Number((isBuy ? price - s.trailDistance : price + s.trailDistance).toFixed(2));
      const improves = isBuy ? desired - p.sl > 0.15 : p.sl - desired > 0.15;
      if (improves) {
        try { await bridge.modifyPosition({ ticket: p.id, stop_loss: desired }); } catch { /* چرخه بعد */ }
      }
    }
  }
}

async function pollPerformance() {
  if (!state.bridgeAlive) return;
  try {
    const deals = await bridge.getDeals();
    const wins = deals.filter((d) => d.profit > 0).length;
    const losses = deals.filter((d) => d.profit < 0).length;
    const net = deals.reduce((a, d) => a + d.profit, 0);
    io.emit('performance', {
      trades: deals.length, wins, losses, net: Number(net.toFixed(2)),
      winRate: deals.length ? Math.round((wins / deals.length) * 100) : null,
    });
  } catch { /* مهم نیست */ }
}

// ---------------------------------------------------------------------------
// شروع / توقف — دیگه به بریج وابسته نیست؛ بدون سیستم خونه هم شروع میشه
// ---------------------------------------------------------------------------
async function startBot() {
  if (state.botActive) return;

  let bridgeOk = false;
  try { await bridge.checkHealth(); bridgeOk = true; } catch { /* خونه خاموشه */ }
  state.bridgeAlive = bridgeOk;
  state.botActive = true;

  resetDailyCounterIfNeeded();
  await pollData();
  await refreshCandles();
  await refreshAnalysisContext();
  if (bridgeOk) pollPerformance();

  state.accountTimer = setInterval(pollData, ACCOUNT_POLL_MS);
  state.candlesTimer = setInterval(refreshCandles, CANDLES_REFRESH_MS);
  state.analysisTimer = setInterval(runAnalysis, ANALYSIS_INTERVAL_MS);
  state.managementTimer = setInterval(managePositions, MANAGEMENT_POLL_MS);
  state.perfTimer = setInterval(pollPerformance, PERF_POLL_MS);

  // چک دوره‌ای برگشت سیستم خونه
  state.revivalTimer = setInterval(async () => {
    if (state.bridgeAlive || !state.botActive) return;
    try { await bridge.checkHealth(); } catch { return; }
    state.bridgeAlive = true;
    log('✅ سیستم خونه آنلاین شد — سوییچ به داده بریج.');
    io.emit('data-source', 'bridge');
    await pollData();
    await refreshCandles();
  }, 60000);

  setTimeout(() => runAnalysis(), 8000);

  io.emit('bot-status', { active: true });
  io.emit('data-source', bridgeOk ? 'bridge' : 'public');
  log(bridgeOk
    ? 'ربات با اتصال کامل به سیستم خونه شروع شد.'
    : '📊 ربات در حالت داده عمومی شروع شد (سیستم خونه خاموش است) — تحلیل کار می‌کنه، معامله نه.');
}

function stopBot() {
  if (!state.botActive) return;
  state.botActive = false;
  [
    state.accountTimer, state.candlesTimer, state.analysisTimer,
    state.managementTimer, state.perfTimer, state.revivalTimer,
  ].forEach(clearInterval);
  state.activeSignal = null;
  io.emit('bot-status', { active: false });
  log('ربات متوقف شد.');
}

// ---------------------------------------------------------------------------
// Socket.io
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  resetDailyCounterIfNeeded();
  socket.emit('settings', state.settings);
  socket.emit('bot-status', { active: state.botActive });
  socket.emit('daily-stats', { count: state.dailySignalCount, max: MAX_DAILY_SIGNALS });
  socket.emit('data-source', state.bridgeAlive ? 'bridge' : 'public');
  emitKeyStatus();

  // آخرین تحلیل و پیش‌بینی رو به کاربر تازه‌وصل‌شده نشون بده
  if (state.lastSignal) socket.emit('signal', state.lastSignal);
  if (state.lastPrediction) socket.emit('prediction', state.lastPrediction);

  socket.on('start-stream', () => startBot());
  socket.on('stop-stream', () => stopBot());

  socket.on('update-settings', (incoming) => {
    if (!incoming || typeof incoming !== 'object') return;
    const s = state.settings;
    const prevMode = s.mode;

    if (typeof incoming.mode === 'string' && ['manual', 'auto', 'signal'].includes(incoming.mode)) {
      s.mode = incoming.mode;
      if (incoming.mode === 'auto' && state.dailyLocked) {
        s.mode = 'manual';
        log('فعال‌سازی خودران ممکن نیست: حد ضرر روزانه فعال است.');
      }
    }
    if (typeof incoming.riskSizing === 'boolean') s.riskSizing = incoming.riskSizing;
    if (typeof incoming.breakEven === 'boolean') s.breakEven = incoming.breakEven;
    if (typeof incoming.trailing === 'boolean') s.trailing = incoming.trailing;
    if (typeof incoming.volume === 'number' && incoming.volume > 0) s.volume = clampNum(incoming.volume, 0.01, 20, s.volume);
    if (typeof incoming.riskPercent === 'number') s.riskPercent = clampNum(incoming.riskPercent, 0.1, 5, s.riskPercent);
    if (typeof incoming.maxPositions === 'number') s.maxPositions = Math.round(clampNum(incoming.maxPositions, 1, 10, s.maxPositions));
    if (typeof incoming.dailyLossLimitPct === 'number') s.dailyLossLimitPct = clampNum(incoming.dailyLossLimitPct, 0, 50, s.dailyLossLimitPct);
    if (typeof incoming.cooldownMinutes === 'number') s.cooldownMinutes = Math.round(clampNum(incoming.cooldownMinutes, 0, 240, s.cooldownMinutes));
    if (typeof incoming.trailDistance === 'number') s.trailDistance = clampNum(incoming.trailDistance, 0.3, 20, s.trailDistance);

    if (s.mode !== prevMode) {
      state.activeSignal = null;
      if (s.mode === 'auto') log('🚀 حالت خودران فعال شد.');
      else if (s.mode === 'signal') log('📊 حالت «فقط تحلیل» فعال شد.');
      else log('حالت دستی فعال شد.');
    }
    emitSettings();
  });

  socket.on('chart-frame', ({ timeframe, data }) => {
    if (timeframe === 'M15' && data) state.lastFrames.M15 = data;
  });

  socket.on('request-prediction', async () => {
    if (state.predictionBusy) return;

    try {
      if (!state.candlesCache.length || !state.m5CandlesCache.length) await refreshCandles();
      if (Date.now() - state.contextRefreshedAt > 5 * 60 * 1000) await refreshAnalysisContext();
      if (!state.lastPrice) {
        const c = await getTf('M5', 2);
        if (c.length) state.lastPrice = c[c.length - 1].close;
      }
    } catch (err) {
      io.emit('prediction', { error: `دریافت داده ناموفق بود: ${err.message}` });
      return;
    }

    state.predictionBusy = true;
    io.emit('prediction-status', { busy: true });
    log('🔍 شروع جست‌وجوی ستاپ پر سود...');

    try {
      let imageDataUrl;
      try { imageDataUrl = await buildChartImage(); }
      catch (err) {
        io.emit('prediction', { error: `رندر چارت ممکن نشد: ${err.message}` });
        return;
      }

      const raw = await predictBigMove(imageDataUrl, state.lastPrice, state.m5CandlesCache, {
        h1Candles: state.h1CandlesCache,
        adr: state.adr,
        todayOpen: state.todayOpen,
        session: getSessionName(),
        utcTime: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
      });

      const validated = validateSignal(raw, state.lastPrice);
      const belowThreshold = ['buy', 'sell'].includes(validated.direction)
        && validated.confidence < CONFIDENCE_THRESHOLD;

      // ⚠️ هیچ placeOrder اینجا صدا زده نمیشه — فقط نمایش
      const payload = { ...validated, belowThreshold };
      state.lastPrediction = payload;
      io.emit('prediction', payload);

      if (['buy', 'sell'].includes(validated.direction)) {
        log(`🎯 پیش‌بینی: ${validated.direction.toUpperCase()} | ورود ${validated.entry} | SL ${validated.stop_loss} | TP ${validated.take_profit} | R/R 1:${validated.rr}`);
      } else {
        log(`پیش‌بینی: ستاپ پر سودی پیدا نشد. ${validated.reason || ''}`);
      }
    } catch (err) {
      log(`خطا در پیش‌بینی: ${err.message}`);
      io.emit('prediction', { error: err.message });
    } finally {
      state.predictionBusy = false;
      io.emit('prediction-status', { busy: false });
      emitKeyStatus();
    }
  });

  socket.on('signal-response', async ({ id, action, volume }) => {
    if (state.settings.mode === 'signal') {
      log('در حالت «فقط تحلیل» سفارشی ارسال نمی‌شود.');
      return;
    }
    if (!state.bridgeAlive) {
      io.emit('alert', { level: 'danger', message: 'سیستم خونه خاموش است؛ اجرای معامله ممکن نیست. تحلیل‌ها با داده عمومی ادامه دارند.' });
      return;
    }

    const signal = state.activeSignal;
    if (!signal || signal.id !== id) { log('این سیگنال دیگر معتبر نیست.'); return; }
    if (signal.expiresAt && Date.now() > signal.expiresAt) {
      state.activeSignal = null;
      log('مهلت پاسخ به سیگنال گذشته بود.');
      return;
    }
    state.activeSignal = null;

    if (action === 'reject') { log('سیگنال رد شد.'); return; }

    const finalVolume = state.settings.riskSizing
      ? await computeLot(signal)
      : (volume || state.settings.volume);
    await executeSignal(signal, finalVolume);
  });

  socket.on('close-position', async ({ id }) => {
    if (!id || !state.bridgeAlive) return;
    try {
      const result = await bridge.closePosition(id);
      log(`پوزیشن #${result.ticket} دستی بسته شد @ ${result.price}`);
      await pollData();
    } catch (err) {
      log(`بستن پوزیشن #${id} ناموفق بود: ${err.message}`);
    }
  });
});

server.listen(PORT, () => {
  console.log(`سرور روی پورت ${PORT} در حال اجراست`);
  console.log(`داشبورد: http://localhost:${PORT}`);
  if (AUTO_START) {
    console.log('شروع خودکار فعال است (AUTO_START=true)');
    startBot();
  }
});