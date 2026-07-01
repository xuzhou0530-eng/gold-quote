// Cloudflare Pages Function — 贵金属行情 API
// 每次 git push 自动部署，与前端同步更新
const OZ_TO_GRAM = 31.1035;

const PRODUCTS = {
  XAU: { sina: "hf_XAU", name: "黄金" },
  XAG: { sina: "hf_XAG", name: "白银" },
  XPT: { sina: "hf_XPT", name: "铂金" },
  XPD: { sina: "hf_XPD", name: "钯金" },
};

const OFFSETS = {
  XAU: { bid: -20, high: -20, low: -20 },
  XAG: { bid:  -3, high:  -3, low:  -3 },
  XPT: { bid: -70, high: -70, low: -70 },
  XPD: { bid: -90, high: -90, low: -90 },
};

export async function onRequest(context) {
  const { request } = context;

  // 缓存：1秒内相同请求直接返回缓存
  const cache = caches.default;
  let response = await cache.match(request);
  if (response) return response;

  try {
    // 拉取新浪数据
    const codes = Object.values(PRODUCTS).map(p => p.sina);
    codes.push("USDCNY");
    const sinaUrl = "https://hq.sinajs.cn/list=" + codes.join(",");

    const sinaResp = await fetch(sinaUrl, {
      headers: { "Referer": "https://finance.sina.com.cn" }
    });

    const buffer = await sinaResp.arrayBuffer();
    const decoder = new TextDecoder("gbk");
    const text = decoder.decode(buffer);

    // 解析
    const raw = {};
    for (const line of text.trim().split("\n")) {
      const m = line.match(/var hq_str_(\w+)="(.*)";/);
      if (m) raw[m[1]] = m[2].split(",");
    }

    // 汇率
    let rate = 7.0;
    const usd = raw["USDCNY"];
    if (usd && usd.length > 1) {
      const r = parseFloat(usd[1]);
      if (r > 0) rate = r;
    }

    // 北京时间 (UTC+8) —— Cloudflare 服务器默认使用 UTC
    const now = new Date();
    const bj = new Date(now.getTime() + 8 * 3600 * 1000);
    const dateKey = `${bj.getUTCFullYear()}-${bj.getUTCMonth()+1}-${bj.getUTCDate()}`;
    const hour = bj.getUTCHours();

    // 铂金/钯金：尝试从缓存中取今天的6:00参考价
    const openCacheUrl = new URL(`/__open/${dateKey}`, request.url);
    let openResp = await cache.match(openCacheUrl);
    let storedOpen = null;
    if (openResp) {
      try { storedOpen = await openResp.json(); } catch(e) {}
    }

    const c = rate / OZ_TO_GRAM;
    const result = {};
    let needStoreOpen = false;

    for (const [key, prod] of Object.entries(PRODUCTS)) {
      const f = raw[prod.sina];
      if (!f || f.length < 10) continue;

      const sf = (i) => { const v = parseFloat(f[i]); return isNaN(v) ? 0 : v; };

      const bid  = sf(0) * c;
      const high = sf(4) * c;
      const low  = sf(5) * c;

      // 参考价
      let ref;
      if (key === "XAU" || key === "XAG") {
        // 现货：昨收优先(昨收有效)
        ref  = (sf(1) || sf(2)) * c;
      } else {
        // 铂金/钯金：以北京时间6:00价格为今开
        if (hour >= 6) {
          if (!storedOpen || storedOpen[key] == null) {
            // 6:00后首次请求，截取当前原始价格(美元)作为今开
            if (!storedOpen) storedOpen = {};
            storedOpen[key] = sf(0);
            needStoreOpen = true;
          }
          ref = storedOpen[key] * c;
        } else {
          // 6:00前用新浪今开兜底
          ref = sf(2) * c;
        }
      }

      // trend: 基于原始数据(floor前)比较最新价 vs 参考价
      const trend = bid > ref ? 1 : (bid < ref ? -1 : 0);

      const off = OFFSETS[key] || {};
      result[key] = {
        name: prod.name,
        bid:   Math.floor(bid  + (off.bid  || 0)),
        open:  Math.floor(ref  + (off.bid  || 0)),
        trend: trend,
        high:  Math.floor(high + (off.high || 0)),
        low:   Math.floor(low  + (off.low  || 0)),
      };
    }

    // 存储自定义今开到缓存（持久化到次日北京时间5:00 = 当日UTC 21:00）
    if (needStoreOpen && storedOpen) {
      // 次日5:00 BJ = 当日21:00 UTC
      const next5amBJ = new Date(Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate(), 21, 0, 0));
      const maxAge = Math.max(60, Math.floor((next5amBJ.getTime() - now.getTime()) / 1000));
      const storeResp = new Response(JSON.stringify(storedOpen), {
        headers: { "Cache-Control": `public, max-age=${maxAge}` }
      });
      context.waitUntil(cache.put(openCacheUrl, storeResp));
    }

    response = new Response(JSON.stringify(result), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=1",
      },
    });

    // 缓存 1 秒，多人访问也只消耗 1 次 Sina 请求
    context.waitUntil(cache.put(request, response.clone()));
    return response;

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
}
