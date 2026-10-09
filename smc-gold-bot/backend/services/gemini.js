// =========================================================================
// ارتباط با Gemini Vision — نسخه چندکلیدی (تا ۸ کلید با سوییچ خودکار)
//
// کلیدها در .env:
//   GEMINI_API_KEY      (کلید اصلی — اول همین استفاده میشه)
//   GEMINI_API_KEY_2 تا GEMINI_API_KEY_8  (پشتیبان‌ها)
//
// رفتار:
//   429 (محدودیت نرخ)  → کلید ۶۰ ثانیه کنار گذاشته میشه، سوییچ به بعدی
//   401/403 (کلید غلط)  → کلید از چرخه خارج میشه تا ری‌استارت سرور
//   5xx / خطای شبکه     → تلاش با کلید بعدی
// =========================================================================

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const COOLDOWN_429_MS = 60 * 1000; // مدت کنار گذاشتن کلیدِ محدودشده
const MAX_ROUNDS = 2;              // حداکثر دفعات دور زدن کل لیست کلیدها

// ---------------------------------------------------------------------------
// مخزن کلیدها
// ---------------------------------------------------------------------------
function loadKeys() {
  const raw = [];

  if (process.env.GEMINI_API_KEY) raw.push(process.env.GEMINI_API_KEY.trim());
  for (let i = 2; i <= 8; i++) {
    const v = process.env[`GEMINI_API_KEY_${i}`];
    if (v && v.trim()) raw.push(v.trim());
  }
  // روش جایگزین: همه کلیدها با کاما در یک متغیر (GEMINI_API_KEYS)
  if (process.env.GEMINI_API_KEYS) {
    process.env.GEMINI_API_KEYS.split(',').forEach((v) => {
      if (v && v.trim()) raw.push(v.trim());
    });
  }

  return [...new Set(raw)] // حذف تکراری‌ها
    .filter((k) => k && !k.startsWith('CHANGE'))
    .map((value, i) => ({
      slot: i + 1,
      value,
      status: 'ok',        // 'ok' | 'invalid'
      cooldownUntil: 0,    // تا این زمان از این کلید استفاده نشود
      requests: 0,
    }));
}

const keyPool = loadKeys();
let keyCursor = 0; // ایندکس آخرین کلید استفاده‌شده

let logCb = () => {};
function setLogger(fn) { if (typeof fn === 'function') logCb = fn; }

function getKeysStatus() {
  const now = Date.now();
  return {
    total: keyPool.length,
    active: keyPool.length ? keyCursor + 1 : 0,
    available: keyPool.filter((k) => k.status === 'ok' && k.cooldownUntil <= now).length,
    cooling: keyPool.filter((k) => k.status === 'ok' && k.cooldownUntil > now).length,
    invalid: keyPool.filter((k) => k.status === 'invalid').length,
  };
}

// انتخاب کلید بعدیِ سالم از محل مکان فعلی (رو به جلو)
function pickKey() {
  const now = Date.now();
  for (let i = 0; i < keyPool.length; i++) {
    const idx = (keyCursor + i) % keyPool.length;
    const k = keyPool[idx];
    if (k.status === 'ok' && k.cooldownUntil <= now) {
      keyCursor = idx;
      return k;
    }
  }
  // همه در دوره سردند؛ نزدیک‌ترین به آزاد شدن را برگردان
  if (keyPool.length) {
    let best = keyPool[0];
    for (const k of keyPool) if (k.cooldownUntil < best.cooldownUntil) best = k;
    keyCursor = keyPool.indexOf(best);
    return best;
  }
  return null;
}

// ---------------------------------------------------------------------------
// ابزارهای کمکی
// ---------------------------------------------------------------------------
function stripDataUrlPrefix(dataUrl) {
  const commaIdx = dataUrl.indexOf(',');
  return commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
}

function safeParseJson(text) {
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function slim(candles, n) {
  return (candles || []).slice(-n).map((c) => ({ t: c.time, o: c.open, h: c.high, l: c.low, c: c.close }));
}

function extractText(data) {
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('پاسخ Gemini خالی یا نامعتبر بود');
  return text;
}

// ---------------------------------------------------------------------------
// تماس با Gemini با چرخش خودکار بین کلیدها
// ---------------------------------------------------------------------------
async function callGemini(userText, base64Image, temperature) {
  if (!keyPool.length) {
    throw new Error('هیچ کلید Gemini در .env تنظیم نشده است (GEMINI_API_KEY و GEMINI_API_KEY_2 تا GEMINI_API_KEY_8)');
  }

  let lastError = null;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    for (let i = 0; i < keyPool.length; i++) {
      if (!keyPool.some((k) => k.status === 'ok')) {
        throw new Error('تمام کلیدهای Gemini نامعتبر شده‌اند — فایل .env را بررسی و سرور را ری‌استارت کن.');
      }

      const key = pickKey();
      if (!key) throw new Error('کلیدی برای استفاده باقی نمانده است');

      // اگر کلید برگزیده هنوز در دوره سرد است، یعنی همه موقتاً محدودند
      if (key.cooldownUntil > Date.now()) {
        const wait = key.cooldownUntil - Date.now();
        if (wait > 12_000) {
          throw new Error('همه کلیدهای Gemini موقتاً به محدودیت نرخ رسیده‌اند؛ چند دقیقه بعد دوباره تلاش کن.');
        }
        await sleep(wait + 250);
      }

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key.value}`;

      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              role: 'user',
              parts: [
                { text: userText },
                { inline_data: { mime_type: 'image/jpeg', data: base64Image } },
              ],
            }],
            generationConfig: { temperature, response_mime_type: 'application/json' },
          }),
        });
      } catch (err) {
        lastError = new Error(`خطای شبکه در تماس با Gemini (کلید #${key.slot}): ${err.message}`);
        logCb(`⚠️ ${lastError.message} — کلید بعدی امتحان می‌شود.`);
        continue;
      }

      key.requests += 1;

      if (res.ok) return res.json();

      const errBody = await res.text().catch(() => '');

      // محدودیت نرخ: این کلید را ۶۰ ثانیه کنار بگذار و برو سراغ بعدی
      if (res.status === 429) {
        key.cooldownUntil = Date.now() + COOLDOWN_429_MS;
        logCb(`⏳ کلید #${key.slot} به محدودیت رسید (429)؛ ۶۰ ثانیه کنار گذاشته شد و سوییچ به کلید بعدی انجام می‌شود.`);
        lastError = new Error(`محدودیت نرخ (429) روی کلید #${key.slot}`);
        continue;
      }

      // خطای موقت سرور گوگل: کمی صبر و کلید بعدی
      if (res.status >= 500) {
        await sleep(1200);
        logCb(`خطای موقت سرور Gemini (${res.status}) روی کلید #${key.slot} — کلید بعدی امتحان می‌شود.`);
        lastError = new Error(`خطای سرور Gemini (${res.status}) روی کلید #${key.slot}`);
        continue;
      }

      // کلید نامعتبر / بی‌دسترس: از چرخه خارجش کن و ادامه بده
      const keyLooksBad = res.status === 401 || res.status === 403
        || /API.?KEY|API key not valid|permission/i.test(errBody.slice(0, 400));

      if (keyLooksBad) {
        if (key.status !== 'invalid') {
          key.status = 'invalid';
          logCb(`❌ کلید #${key.slot} نامعتبر یا بی‌دسترس است (${res.status}) و از چرخه خارج شد.`);
        }
        lastError = new Error(`کلید #${key.slot} نامعتبر است (${res.status})`);
        continue;
      }

      // سایر خطاها (مثل 400 بدنه نامعتبر) ربطی به کلید ندارند؛ مستقیم پرتاب
      throw new Error(`خطای Gemini API (${res.status}): ${errBody.slice(0, 200)}`);
    }
  }

  throw lastError || new Error('تماس با Gemini پس از امتحان همه کلیدها ناموفق بود');
}

// ---------------------------------------------------------------------------
// پرامپت‌ها (بدون تغییر)
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `
تو «موتور تحلیل SMC» یک میز معامله‌گری حرفه‌ای طلا (XAUUSD) هستی.

ورودی‌ها:
- تصویر: نمودار کندلی M15 (تایم‌فریم اصلی تصمیم‌گیری)
- ساختار H1 (JSON): برای تعیین بایاس روزانه
- کندل‌های M5 (JSON): برای تأیید دقیق نقطه ورود
- اطلاعات بازار: سشن فعال، ADR و میزان حرکت روز

چارچوب تحلیل (Smart Money Concepts + Price Action):
۱. بایاس H1: روند غالب و ساختار سوئینگ‌ها. خلاف بایاس H1 معامله نکن مگر CHoCH واضح و تاییدشده در M15 داشته باشی.
۲. ساختار M15: آخرین BOS/CHoCH و سوئینگ‌های معتبر.
۳. Order Block: آخرین کندل مخالف قبل از حرکت ضربه‌ای؛ ستاپ‌های بهترین کیفیت وقتیه که قیمت هنوز به OB برنگشته (unmitigated).
۴. FVG / Liquidity Void: شکاف قیمتی سه‌کندلی و بازگشت قیمت به اون.
۵. Liquidity: سقف/کف‌های هم‌سطح (equal highs/lows) و sweep های اخیر؛ قیمت به سمت نقدینگی باقی‌مانده جذب میشه.
۶. فیبوناچی OTE: ناحیه ۶۱.۸٪ تا ۷۹٪ از پا حرکتی اخیر؛ هم‌پوشانی با OB یا FVG کیفیت ورود رو خیلی بالا می‌بره.
۷. Premium/Discount: در نیمه بالای رنج فعلی فقط sell و در نیمه پایین فقط buy منطقیه.
۸. سشن و ADR: ستاپ‌های باکیفیت عمدتاً در کیل‌زون لندن و نیویورک رخ میدن؛ خارج از اون‌ها سخت‌گیرتر باش. اگه قیمت امروز بیشتر از ~۷۰٪ ADR رو حرکت کرده، دنبال‌کردن حرکت ممنوع — احتمال بازگشت یا رنج بالاست.

شرایط صدور سیگنال buy/sell (همه باید برقرار باشن):
- جهت سیگنال هم‌راستا با بایاس H1 (یا CHoCH تاییدشده خلاف اون)
- حداقل ۳ هم‌پوشانی از مفاهیم بالا در ناحیه ورود
- تأیید رفتاری کندل‌های M5 در ناحیه (واکنش، wick رد شدن، شکست ساختار کوچک)
- حد ضرر پشت Order Block یا زیر/بالای سوئینگ معتبر — نه یک عدد دلبخواه
- حد سود به سمت نقدینگی مقابل یا حد ساختاری؛ نسبت سود به ضرر (R:R) حداقل 1:1.5 و ترجیحاً 1:2 به بالا
- اطمینان صادقانه؛ اگه شواهد کافی نیست حتماً wait برگردون. یک سیگنال درست از ده سیگنال مشکوک بهتره.

خروجی فقط و فقط یک JSON خام و معتبر، بدون backtick و بدون هیچ متن اضافه:
{
  "direction": "buy" | "sell" | "wait",
  "entry": number,
  "stop_loss": number,
  "take_profit": number,
  "confidence": number,
  "rr": number,
  "reason": "توضیح کوتاه فارسی: سشن، کدام مفاهیم هم‌پوشانی داشتن و منطق SL/TP"
}

اگر direction برابر wait است، entry و stop_loss و take_profit و rr را 0 بذار. confidence عددی بین 0 تا 1.
`.trim();

const PREDICTION_PROMPT = `
تو «موتور پیش‌بینی» یک میز معامله‌گری حرفه‌ای طلا (XAUUSD) هستی.

وظیفه تو پیدا کردن «یک ستاپ واحد با بالاترین ترکیب احتمال موفقیت و نسبت سود به ضرر»
در چارت فعلی است. خروجی تو فقط برای نمایش به معامله‌گر است و هیچ‌جا به‌صورت خودکار
اجرا نخواهد شد؛ پس می‌توانی ستاپ‌های جسورانه‌تر (اهداف دورتر) را هم گزارش کنی،
به شرطی که منطق ساختاری آن‌ها مستدل باشد.

روش تحلیل:
۱) در H1 نقاط نقدینگی بزرگ را مشخص کن: سقف/کف سوئینگ‌های معتبر، equal highs/lows
   و نواحی ناتوان. این‌ها اهداف طبیعی حرکت بعدی قیمت‌اند.
۲) در M15 ساختار فعلی و آخرین BOS/CHoCH را پیدا کن و تعیین کن قیمت به سمت
   کدام نقدینگی H1 حرکت منطقی‌تری دارد.
۳) نزدیک‌ترین ناحیه ورود باکیفیت را در مسیر این حرکت شناسایی کن:
   هم‌پوشانی Order Block + FVG + ناحیه OTE (61.8٪ تا 78.6٪ فیبوناچی پا سوئینگ اخیر).
۴) ستاپ نهایی باید این شرایط را داشته باشد:
   - نقطه ورود واضح باشد: یا قیمت فعلی (market) یا پولبک به ناحیه (pullback)
   - حد ضرر پشت سطح ساختاری معتبر (Order Block یا سوئینگ) باشد، نه عدد دلخواه
   - حد سود اصلی روی نقدینگی یا ساختار مقابل در H1 باشد؛ اگر مسیر بازتر است،
     هدف دوم (tp2) دورتر را هم بده
   - نسبت سود به ضرر حداقل 1:2.5 و ترجیحاً 1:3 به بالا باشد
   - رفتار کندل‌های M5 اخیر ناحیه ورود را تأیید کند
۵) اگر چنین ستاپی الان در چارت وجود ندارد، صادقانه wait برگردان. ستاپ ساختگی
   نساز — پیش‌بینی غلط بدتر از نداشتن پیش‌بینی است.

صداقت: عدد confidence باید واقعی باشد؛ «پر سود» به معنای تضمین سود نیست و تو
نباید آن را القا کنی. اطمینان را بر اساس کیفیت هم‌پوشانی شواهد بده.

خروجی فقط و فقط یک JSON خام معتبر، بدون backtick و بدون هیچ متن اضافه:
{
  "direction": "buy" | "sell" | "wait",
  "entry": number,
  "entry_type": "market" | "pullback",
  "stop_loss": number,
  "take_profit": number,
  "tp2": number,
  "confidence": number,
  "rr": number,
  "expected_duration": "بازه زمانی محتمل رسیدن به هدف، مثلا: ۶ تا ۲۴ ساعت",
  "invalidation": "شرط یا رویدادی که ستاپ را باطل می‌کند",
  "reason": "توضیح فارسی: مسیر نقدینگی هدف، ناحیه ورود و منطق حد ضرر و حد سود"
}

اگر direction برابر wait است همه اعداد را 0 و متن‌ها را خالی بگذار.
rr را بر اساس فاصله واقعی entry تا TP و SL حساب کن.
`.trim();

// ---------------------------------------------------------------------------
// تحلیل دوره‌ای
// ---------------------------------------------------------------------------
async function analyzeChart(chartFrameDataUrl, currentPrice, m5Candles = [], context = {}) {
  const base64Image = stripDataUrlPrefix(chartFrameDataUrl);

  const adrText = context.adr ? `ADR (میانگین دامنه روزانه ۱۰ روز اخیر): ${context.adr.toFixed(2)} دلار` : '';
  let moveText = '';
  if (context.todayOpen && currentPrice && context.adr) {
    const move = currentPrice - context.todayOpen;
    const pct = Math.round((Math.abs(move) / context.adr) * 100);
    moveText = `حرکت امروز از ابتدای روز: ${move >= 0 ? '+' : ''}${move.toFixed(2)} دلار (حدود ${pct}٪ از ADR)`;
  }

  const userText = [
    'اطلاعات بازار:',
    context.utcTime ? `زمان: ${context.utcTime}` : '',
    context.session ? `سشن فعال: ${context.session}` : '',
    adrText,
    moveText,
    `قیمت لحظه‌ای فعلی XAUUSD: ${currentPrice ?? 'نامشخص'}`,
    '',
    'ساختار H1 برای تعیین بایاس (جدیدترین کندل در انتها):',
    JSON.stringify(slim(context.h1Candles, 40)),
    '',
    'کندل‌های M5 برای تأیید ورود (جدیدترین در انتها):',
    JSON.stringify(slim(m5Candles, 30)),
  ].filter(Boolean).join('\n');

  const data = await callGemini(`${SYSTEM_PROMPT}\n\n${userText}`, base64Image, 0.2);
  const parsed = safeParseJson(extractText(data));

  return {
    direction: (parsed.direction || 'wait').toLowerCase(),
    entry: Number(parsed.entry) || 0,
    stop_loss: Number(parsed.stop_loss) || 0,
    take_profit: Number(parsed.take_profit) || 0,
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
    rr: Number(parsed.rr) || 0,
    reason: parsed.reason || '',
  };
}

// ---------------------------------------------------------------------------
// پیش‌بینی معامله پر سود (فقط نمایش، بدون اجرا)
// ---------------------------------------------------------------------------
async function predictBigMove(chartFrameDataUrl, currentPrice, m5Candles = [], context = {}) {
  const base64Image = stripDataUrlPrefix(chartFrameDataUrl);

  const userText = [
    'اطلاعات بازار:',
    context.utcTime ? `زمان: ${context.utcTime}` : '',
    context.session ? `سشن فعال: ${context.session}` : '',
    context.adr ? `ADR (میانگین دامنه روزانه): ${context.adr.toFixed(2)} دلار` : '',
    `قیمت لحظه‌ای فعلی XAUUSD: ${currentPrice ?? 'نامشخص'}`,
    '',
    'ساختار H1 برای بایاس و اهداف نقدینگی بزرگ (جدیدترین کندل در انتها):',
    JSON.stringify(slim(context.h1Candles, 60)),
    '',
    'کندل‌های M5 برای تأیید ناحیه ورود (جدیدترین در انتها):',
    JSON.stringify(slim(m5Candles, 40)),
  ].filter(Boolean).join('\n');

  const data = await callGemini(`${PREDICTION_PROMPT}\n\n${userText}`, base64Image, 0.3);
  const parsed = safeParseJson(extractText(data));

  return {
    direction: (parsed.direction || 'wait').toLowerCase(),
    entry: Number(parsed.entry) || 0,
    entry_type: parsed.entry_type === 'pullback' ? 'pullback' : 'market',
    stop_loss: Number(parsed.stop_loss) || 0,
    take_profit: Number(parsed.take_profit) || 0,
    tp2: Number(parsed.tp2) || 0,
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
    rr: Number(parsed.rr) || 0,
    expected_duration: String(parsed.expected_duration || ''),
    invalidation: String(parsed.invalidation || ''),
    reason: parsed.reason || '',
  };
}

module.exports = { analyzeChart, predictBigMove, setLogger, getKeysStatus };