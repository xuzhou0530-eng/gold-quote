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
  XAU: { bid: -30, high: -30, low: -30 },
  XAG: { bid:  -3, high:  -3, low:  -3 },
  XPT: { bid: -75, high: -75, low: -75 },
  XPD: { bid: -90, high: -90, low: -90 },
};

export async function onRequest(context) {
  const { request } = context;

  // 缓存：3秒内相同请求直接返回缓存
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

    const c = rate / OZ_TO_GRAM;
    const result = {};

    for (const [key, prod] of Object.entries(PRODUCTS)) {
      const f = raw[prod.sina];
      if (!f || f.length < 10) continue;

      const sf = (i) => { const v = parseFloat(f[i]); return isNaN(v) ? 0 : v; };

      // fields[0]=最新价 fields[1]=昨收 fields[2]=今开(现货不可靠) fields[4]=最高 fields[5]=最低
      const bid  = sf(0) * c;
      const ref  = (sf(1) || sf(2)) * c; // 昨收优先(现货有效)，为空则今开(期货)
      const high = sf(4) * c;
      const low  = sf(5) * c;

      // trend: 基于原始数据(floor前)比较最新价 vs 昨收/今开
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

    response = new Response(JSON.stringify(result), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=3",
      },
    });

    // 缓存 3 秒，多人访问也只消耗 1 次 Sina 请求
    context.waitUntil(cache.put(request, response.clone()));
    return response;

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
}
