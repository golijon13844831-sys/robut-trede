// چک‌های منطقی روی خروجی Gemini — نسخه پرو: + حداقل نسبت سود به ضرر

const MAX_ENTRY_DISTANCE_RATIO = 0.01;
const MIN_SL_DISTANCE_RATIO = 0.0005;
const MAX_SL_DISTANCE_RATIO = 0.05;
const MIN_RR = 1.5;

function validateSignal(signal, currentPrice) {
  if (!signal || !['buy', 'sell'].includes(signal.direction)) {
    return { ...signal, direction: 'wait' };
  }

  const { entry, stop_loss: sl, take_profit: tp, direction } = signal;

  if (!entry || !sl || !tp) {
    return { ...signal, direction: 'wait', reason: 'خروجی ناقص بود (entry/SL/TP).' };
  }

  if (currentPrice) {
    const entryDistance = Math.abs(entry - currentPrice) / currentPrice;
    if (entryDistance > MAX_ENTRY_DISTANCE_RATIO) {
      return { ...signal, direction: 'wait', reason: `فاصله ورود از قیمت لحظه‌ای غیرمنطقی بود (${(entryDistance * 100).toFixed(2)}٪).` };
    }
  }

  const slDistance = Math.abs(entry - sl) / entry;
  if (slDistance < MIN_SL_DISTANCE_RATIO || slDistance > MAX_SL_DISTANCE_RATIO) {
    return { ...signal, direction: 'wait', reason: 'فاصله حد ضرر از ورود غیرمنطقی بود.' };
  }

  const structureOk = direction === 'buy' ? sl < entry && entry < tp : sl > entry && entry > tp;
  if (!structureOk) {
    return { ...signal, direction: 'wait', reason: 'ترتیب حد ضرر/ورود/حد سود با جهت سیگنال همخوانی نداشت.' };
  }

  const rr = Math.abs(tp - entry) / Math.abs(entry - sl);
  if (rr < MIN_RR) {
    return { ...signal, direction: 'wait', reason: `نسبت سود به ضرر (${rr.toFixed(2)}) کمتر از حداقل ${MIN_RR} بود.` };
  }

  return { ...signal, rr: Number(rr.toFixed(2)) };
}

module.exports = { validateSignal };