#!/usr/bin/env python3
"""
贵金属实时行情代理
数据源：新浪财经 hq.sinajs.cn
所有国际价格换算为 人民币/克
"""
import asyncio
import json
import math
import re
import ssl
import time
from pathlib import Path

import certifi

try:
    import aiohttp
    from aiohttp import web
except ImportError:
    print("请先安装 aiohttp: pip3 install aiohttp")
    raise

# ============ 配置 ============
HTTP_PORT = 3456
POLL_INTERVAL = 3  # 新浪轮询间隔（秒）
PUBLIC_DIR = Path(__file__).parent / "public"
OZ_TO_GRAM = 31.1035  # 1金衡盎司 = 31.1035克

# ============ 产品定义 ============
# 国际现货/期货（原始单位 美元/盎司 → 人民币/克）
PRODUCTS = {
    "XAU": {"sina": "hf_XAU", "name": "黄金"},
    "XAG": {"sina": "hf_XAG", "name": "白银"},
    "XPT": {"sina": "hf_XPT", "name": "铂金"},
    "XPD": {"sina": "hf_XPD", "name": "钯金"},
}

# 所有需要请求的新浪代码
ALL_SINA_CODES = [p["sina"] for p in PRODUCTS.values()] + ["USDCNY"]

# ============ 价格偏移（显示值 = 原始值 + 偏移） ============
OFFSETS = {
    "XAU": {"bid": -30, "high": -30, "low": -30},
    "XAG": {"bid":  -3, "high":  -3, "low":  -3},
    "XPT": {"bid": -75, "high": -75, "low": -75},
    "XPD": {"bid": -90, "high": -90, "low": -90},
}

# ============ 新浪字段索引 ============
# hf_* 国际: 0:最新价 1:昨收(现货有效) 2:今开(期货) 4:最高 5:最低 6:时间 7:买价 8:卖价 12:日期 13:名称
# 注意: 现货黄金/白银 fields[2] 为实时变动值并非固定今开，故涨跌用昨收(fields[1])

# ============ 全局状态 ============
quotes = {}
usdcny = 6.78
ws_clients = set()

# ============ 工具 ============
def sf(val, default=0.0):
    try:
        return float(val) if val != "" else default
    except (ValueError, TypeError):
        return default

# ============ 新浪抓取 & 解析 ============
async def fetch_sina(session):
    url = f"https://hq.sinajs.cn/list={','.join(ALL_SINA_CODES)}"
    headers = {"Referer": "https://finance.sina.com.cn"}
    try:
        async with session.get(url, headers=headers,
                               timeout=aiohttp.ClientTimeout(total=5)) as resp:
            raw = await resp.text(encoding="gb2312")
    except Exception as e:
        print(f"[SINA] 请求失败: {e}")
        return {}
    result = {}
    for line in raw.strip().split("\n"):
        m = re.match(r'var hq_str_(\w+)="(.*)";', line)
        if m:
            code, data = m.groups()
            if data:
                result[code] = data.split(",")
    return result

def parse_intl(fields, rate):
    """国际品种: 美元/盎司 → 人民币/克"""
    c = rate / OZ_TO_GRAM
    price = sf(fields[0]) * c
    prev  = sf(fields[1]) * c
    # 昨收优先(现货有效)，昨收为空则用今开(期货)
    ref   = (sf(fields[1]) or sf(fields[2])) * c
    bid   = sf(fields[0]) * c
    ask   = sf(fields[8]) * c
    high  = sf(fields[4]) * c
    low   = sf(fields[5]) * c
    # trend: 基于原始数据(floor前)比较最新价 vs 昨收/今开
    trend = 1 if bid > ref else (-1 if bid < ref else 0)
    chg = f"{(price - prev) / prev * 100:+.2f}%" if prev > 0 else ""
    return {
        "price": round(price, 2), "bid": round(bid or price, 2),
        "open": round(ref, 2),
        "ask": round(ask or price, 2), "high": round(high, 2),
        "low": round(low, 2), "change_pct": chg,
        "trend": trend,
        "time": fields[6] if len(fields) > 6 else "",
    }

# ============ WebSocket ============
def ws_msg(mtype, data):
    return json.dumps({"type": mtype, "data": data}, ensure_ascii=False)

async def broadcast():
    if not ws_clients: return
    payload = ws_msg("init", quotes)
    dead = []
    for ws in ws_clients:
        try:
            await ws.send_str(payload)
        except Exception:
            dead.append(ws)
    for ws in dead:
        ws_clients.discard(ws)

# ============ 主循环 ============
async def poll_loop():
    global quotes, usdcny
    ssl_context = ssl.create_default_context(cafile=certifi.where())
    connector = aiohttp.TCPConnector(limit=1, force_close=True, ssl=ssl_context)
    async with aiohttp.ClientSession(connector=connector) as session:
        while True:
            try:
                raw = await fetch_sina(session)
                if not raw:
                    await asyncio.sleep(POLL_INTERVAL)
                    continue

                # 汇率
                usd = raw.get("USDCNY")
                if usd and len(usd) > 1:
                    r = sf(usd[1])
                    if r > 0: usdcny = r
                rate = usdcny

                new_q = {}

                # 国际品种
                for key, prod in PRODUCTS.items():
                    f = raw.get(prod["sina"])
                    if f and len(f) >= 10:
                        d = parse_intl(f, rate)
                        d["name"] = prod["name"]
                        # 应用价格偏移 + 向下取整到0.5
                        off = OFFSETS.get(key, {})
                        for col in ("bid", "open", "high", "low"):
                            v = d[col]
                            if col in off:
                                v += off[col]
                            d[col] = float(math.floor(v))
                        new_q[key] = d

                # 汇率
                if usd and len(usd) > 7:
                    new_q["USDCNY"] = {
                        "name": "美元人民币", "icon": "💱",
                        "price": round(usdcny, 4),
                        "bid": round(usdcny, 4), "ask": round(usdcny, 4),
                        "high": round(sf(usd[6]), 4), "low": round(sf(usd[5]), 4),
                        "change_pct": "", "time": usd[0],
                    }

                quotes = new_q
                if ws_clients:
                    await broadcast()

                # 日志
                items = [f"{k}={quotes[k]['price']}" for k in ("XAU","XAG") if k in quotes]
                print(f"[{time.strftime('%H:%M:%S')}] 汇率{rate:.4f} | {' | '.join(items)}")

            except Exception as e:
                print(f"[POLL] {e}")
                import traceback; traceback.print_exc()
            await asyncio.sleep(POLL_INTERVAL)

# ============ HTTP ============
async def index_handler(request):
    return web.FileResponse(PUBLIC_DIR / "index.html")

async def static_handler(request):
    fn = request.match_info.get("filename", "")
    p = PUBLIC_DIR / fn
    if p.exists() and p.is_relative_to(PUBLIC_DIR):
        return web.FileResponse(p)
    raise web.HTTPNotFound()

async def ws_handler(request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    ws_clients.add(ws)
    print(f"[WS] 连接 ({len(ws_clients)} 在线)")
    if quotes:
        await ws.send_str(ws_msg("init", quotes))
    try:
        async for _ in ws: pass
    finally:
        ws_clients.discard(ws)
        print(f"[WS] 断开 ({len(ws_clients)} 在线)")
    return ws

async def api_handler(request):
    """GET /api/quote —— 供前端 HTTP 轮询"""
    return web.json_response(quotes)

# ============ 入口 ============
def main():
    print("=" * 48)
    print("  贵金属实时行情 (新浪财经)")
    print(f"  http://localhost:{HTTP_PORT}")
    print("=" * 48)

    app = web.Application()
    app.router.add_get("/", index_handler)
    app.router.add_get("/api/quote", api_handler)
    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/{filename}", static_handler)

    async def startup(app):
        asyncio.create_task(poll_loop())
    app.on_startup.append(startup)

    web.run_app(app, host="0.0.0.0", port=HTTP_PORT, print=lambda *_: None)

if __name__ == "__main__":
    main()
