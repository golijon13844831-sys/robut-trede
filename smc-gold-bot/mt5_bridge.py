"""
پل پایتون بین MT5 و Node.js — نسخه پرو

اجرا:
    uvicorn mt5_bridge:app --host 0.0.0.0 --port 5005
"""

import os
from datetime import datetime, timedelta
from typing import Optional

import MetaTrader5 as mt5
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

API_KEY = os.environ.get("BRIDGE_API_KEY", "CHANGE-THIS-TO-A-SECRET-KEY")
MAGIC = 20260830

app = FastAPI(title="MT5 Bridge Pro")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

SYMBOL_CANDIDATES = ["XAUUSD", "XAUUSD.", "XAUUSDm", "GOLD", "XAUUSD_i"]
_resolved_symbol: Optional[str] = None


def check_key(x_api_key: str = Header(default="")):
    if x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="کلید API نامعتبر است")


def get_symbol() -> str:
    global _resolved_symbol
    if _resolved_symbol:
        return _resolved_symbol
    for sym in SYMBOL_CANDIDATES:
        if mt5.symbol_info(sym) is not None:
            mt5.symbol_select(sym, True)
            _resolved_symbol = sym
            return sym
    raise HTTPException(status_code=500, detail="نماد طلا پیدا نشد")


@app.on_event("startup")
def startup():
    if not mt5.initialize():
        raise RuntimeError(f"اتصال به MT5 برقرار نشد: {mt5.last_error()}")


@app.on_event("shutdown")
def shutdown():
    mt5.shutdown()


@app.get("/health")
def health():
    return {"status": "ok", "time": datetime.utcnow().isoformat()}


@app.get("/account")
def account(x_api_key: str = Header(default="")):
    check_key(x_api_key)
    info = mt5.account_info()
    if info is None:
        raise HTTPException(status_code=500, detail=str(mt5.last_error()))
    return {
        "login": info.login,
        "server": info.server,
        "balance": info.balance,
        "equity": info.equity,
        "free_margin": info.margin_free,
        "currency": info.currency,
    }


@app.get("/positions")
def positions(x_api_key: str = Header(default="")):
    check_key(x_api_key)
    symbol = get_symbol()
    pos = mt5.positions_get(symbol=symbol)
    if pos is None:
        return []
    return [
        {
            "id": p.ticket,
            "type": "BUY" if p.type == mt5.ORDER_TYPE_BUY else "SELL",
            "volume": p.volume,
            "entry": p.price_open,
            "sl": p.sl,
            "tp": p.tp,
            "profit": round(p.profit, 2),
        }
        for p in pos
    ]


@app.get("/price")
def price(x_api_key: str = Header(default="")):
    check_key(x_api_key)
    symbol = get_symbol()
    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        raise HTTPException(status_code=500, detail=str(mt5.last_error()))
    return {
        "symbol": symbol,
        "bid": tick.bid,
        "ask": tick.ask,
        "time": datetime.fromtimestamp(tick.time).isoformat(),
    }


@app.get("/symbol-info")
def symbol_info_route(x_api_key: str = Header(default="")):
    # برای محاسبه حجم ریسک‌محور در Node.js
    check_key(x_api_key)
    symbol = get_symbol()
    info = mt5.symbol_info(symbol)
    if info is None:
        raise HTTPException(status_code=500, detail=str(mt5.last_error()))
    return {
        "symbol": symbol,
        "digits": info.digits,
        "volume_min": info.volume_min,
        "volume_max": info.volume_max,
        "volume_step": info.volume_step,
        "tick_value": info.trade_tick_value,
        "tick_size": info.trade_tick_size,
    }


@app.get("/deals")
def deals(x_api_key: str = Header(default="")):
    # معاملات بسته‌شده ۲۶ ساعت اخیر که magic ربات رو دارن (برای آمار عملکرد)
    check_key(x_api_key)
    now = datetime.now()
    start = now - timedelta(hours=26)
    all_deals = mt5.history_deals_get(start, now)
    if all_deals is None:
        return []
    out = []
    for d in all_deals:
        if d.magic != MAGIC or d.entry != mt5.DEAL_ENTRY_OUT:
            continue
        out.append({
            "ticket": d.ticket,
            "position_id": d.position_id,
            "profit": round(d.profit + d.commission + d.swap, 2),
            "volume": d.volume,
            "time": datetime.fromtimestamp(d.time).isoformat(),
        })
    return out


TIMEFRAME_MAP = {
    "M1": mt5.TIMEFRAME_M1,
    "M5": mt5.TIMEFRAME_M5,
    "M15": mt5.TIMEFRAME_M15,
    "M30": mt5.TIMEFRAME_M30,
    "H1": mt5.TIMEFRAME_H1,
    "H4": mt5.TIMEFRAME_H4,
    "D1": mt5.TIMEFRAME_D1,
}


@app.get("/candles")
def candles(timeframe: str = "M15", count: int = 200, x_api_key: str = Header(default="")):
    check_key(x_api_key)
    if timeframe not in TIMEFRAME_MAP:
        raise HTTPException(status_code=400, detail=f"تایم‌فریم نامعتبر. یکی از: {list(TIMEFRAME_MAP)}")
    symbol = get_symbol()
    rates = mt5.copy_rates_from_pos(symbol, TIMEFRAME_MAP[timeframe], 0, count)
    if rates is None:
        raise HTTPException(status_code=500, detail=str(mt5.last_error()))
    return [
        {
            "time": datetime.fromtimestamp(r["time"]).isoformat(),
            "open": float(r["open"]),
            "high": float(r["high"]),
            "low": float(r["low"]),
            "close": float(r["close"]),
            "volume": int(r["tick_volume"]),
        }
        for r in rates
    ]


class OrderRequest(BaseModel):
    direction: str
    volume: float
    stop_loss: float
    take_profit: float
    comment: str = "smc-bot"


@app.post("/order")
def place_order(order: OrderRequest, x_api_key: str = Header(default="")):
    check_key(x_api_key)
    if order.direction not in ("buy", "sell"):
        raise HTTPException(status_code=400, detail="direction باید buy یا sell باشه")
    if order.volume <= 0:
        raise HTTPException(status_code=400, detail="volume باید بزرگتر از صفر باشه")

    symbol = get_symbol()
    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        raise HTTPException(status_code=500, detail=str(mt5.last_error()))

    price_used = tick.ask if order.direction == "buy" else tick.bid
    order_type = mt5.ORDER_TYPE_BUY if order.direction == "buy" else mt5.ORDER_TYPE_SELL

    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": order.volume,
        "type": order_type,
        "price": price_used,
        "sl": order.stop_loss,
        "tp": order.take_profit,
        "deviation": 20,
        "magic": MAGIC,
        "comment": order.comment,
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }
    result = mt5.order_send(request)
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        raise HTTPException(
            status_code=400,
            detail=f"سفارش رد شد. retcode={result.retcode} کامنت={result.comment}",
        )
    return {"status": "executed", "order_id": result.order, "price": result.price, "volume": result.volume}


class CloseRequest(BaseModel):
    ticket: int


@app.post("/close")
def close_position(req: CloseRequest, x_api_key: str = Header(default="")):
    check_key(x_api_key)
    positions = mt5.positions_get(ticket=req.ticket)
    if not positions:
        raise HTTPException(status_code=404, detail="پوزیشن با این تیکت پیدا نشد یا قبلاً بسته شده")

    pos = positions[0]
    tick = mt5.symbol_info_tick(pos.symbol)
    if tick is None:
        raise HTTPException(status_code=500, detail=str(mt5.last_error()))

    if pos.type == mt5.ORDER_TYPE_BUY:
        close_type, price_used = mt5.ORDER_TYPE_SELL, tick.bid
    else:
        close_type, price_used = mt5.ORDER_TYPE_BUY, tick.ask

    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": pos.symbol,
        "volume": pos.volume,
        "type": close_type,
        "position": pos.ticket,
        "price": price_used,
        "deviation": 20,
        "magic": MAGIC,
        "comment": "smc-gemini-bot-manual-close",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }
    result = mt5.order_send(request)
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        raise HTTPException(status_code=400, detail=f"بستن ناموفق. retcode={result.retcode} کامنت={result.comment}")
    return {"status": "closed", "ticket": pos.ticket, "price": result.price, "volume": result.volume}


class ModifyRequest(BaseModel):
    ticket: int
    stop_loss: Optional[float] = None
    take_profit: Optional[float] = None


@app.post("/modify")
def modify_position(req: ModifyRequest, x_api_key: str = Header(default="")):
    # تغییر SL/TP پوزیشن باز — برای سربه‌سركردن و تریلینگ استاپ
    check_key(x_api_key)
    positions = mt5.positions_get(ticket=req.ticket)
    if not positions:
        raise HTTPException(status_code=404, detail="پوزیشن پیدا نشد یا بسته شده")

    pos = positions[0]
    new_sl = req.stop_loss if req.stop_loss is not None else pos.sl
    new_tp = req.take_profit if req.take_profit is not None else pos.tp

    request = {
        "action": mt5.TRADE_ACTION_SLTP,
        "symbol": pos.symbol,
        "position": pos.ticket,
        "sl": new_sl,
        "tp": new_tp,
    }
    result = mt5.order_send(request)
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        raise HTTPException(status_code=400, detail=f"تغییر SL/TP رد شد. retcode={result.retcode} {result.comment}")
    return {"status": "modified", "ticket": pos.ticket, "sl": new_sl, "tp": new_tp}
