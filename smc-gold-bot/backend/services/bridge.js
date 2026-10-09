// ارتباط با پل پایتون (mt5_bridge.py) — نسخه پرو

const BRIDGE_URL = process.env.BRIDGE_URL || 'http://127.0.0.1:5005';
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY || '';

async function bridgeFetch(path, options = {}) {
  const res = await fetch(`${BRIDGE_URL}${path}`, {
    ...options,
    headers: {
      'X-API-Key': BRIDGE_API_KEY,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`پل پایتون خطا داد (${res.status}): ${body?.detail || res.statusText}`);
  }
  return body;
}

async function getAccount() { return bridgeFetch('/account'); }
async function getPrice() { return bridgeFetch('/price'); }
async function getPositions() { return bridgeFetch('/positions'); }
async function getSymbolInfo() { return bridgeFetch('/symbol-info'); }
async function getDeals() { return bridgeFetch('/deals'); }

async function getCandles(timeframe = 'M15', count = 200) {
  return bridgeFetch(`/candles?timeframe=${timeframe}&count=${count}`);
}

async function placeOrder({ direction, volume, stop_loss, take_profit, comment }) {
  return bridgeFetch('/order', {
    method: 'POST',
    body: JSON.stringify({ direction, volume, stop_loss, take_profit, comment }),
  });
}

async function modifyPosition({ ticket, stop_loss, take_profit }) {
  return bridgeFetch('/modify', {
    method: 'POST',
    body: JSON.stringify({ ticket, stop_loss, take_profit }),
  });
}

async function closePosition(ticket) {
  return bridgeFetch('/close', { method: 'POST', body: JSON.stringify({ ticket }) });
}

async function checkHealth() {
  const res = await fetch(`${BRIDGE_URL}/health`);
  if (!res.ok) throw new Error('پل پایتون در دسترس نیست');
  return res.json();
}

module.exports = {
  getAccount, getPrice, getPositions, getCandles, getSymbolInfo, getDeals,
  placeOrder, modifyPosition, closePosition, checkHealth,
};
