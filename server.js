// 贵金属行情代理服务器
// 连接融通金 WebSocket，解析行情数据并提供给前端
// 注意：手写 Protobuf 编解码，避免 protobufjs 在 Node v25 上的兼容问题

const WebSocket = require("ws");
const { Blowfish } = require("egoroof-blowfish");
const express = require("express");
const http = require("http");
const path = require("path");

process.stdout.write("[INIT] 所有依赖加载完成\n");

// ========== 配置 ==========
const WS_URL = "wss://rtjwbqt.ytj9999.com:8443/gateway";
const AUTH = {
  apptype: "rtj",
  verifycode: "plaintract",
  key: "tdc5%y4yaU@xFi",
  iv: "5X4f$^hp",
};

// ========== QuoteMsgID 枚举 ==========
const MsgID = {
  quotation_broadcast: 0,
  status_broadcast: 1,
  heart_beat: 16,
  latestQuotation: 18,
  qryQuotation: 20,
  unsubscribe: 24,
  qry_status: 28,
  qry_gold_delivery: 30,
  auth: 32,
  waring: 34,
  qry_waring: 36,
  codes_category_json: 64,
  codes_info_json: 66,
  codes_f10_json: 68,
  qry_all_settle: 70,
  qry_option_info: 80,
};

// ========== 产品定义 ==========
const RTG_PRODUCTS = ["JZJ_au","JZJ_ag","JZJ_pt","JZJ_pd","RH_JZL","JZJ_IR","JZJ_RU"];
const NORMAL_CODES = ["Au99.99","Au(T+D)","Ag(T+D)","Pt99.95","GLNC","SLNC","PLNC","PANC","XAU","XAG","XAP","XPD","USDCNH"];
const PRODUCT_NAMES = {
  JZJ_au:"黄 金", JZJ_ag:"白 银", JZJ_pt:"铂 金", JZJ_pd:"钯 金", RH_JZL:"铑 金",
  "Au99.99":"黄金9999","Au(T+D)":"黄金T+D","Ag(T+D)":"白银T+D","Pt99.95":"铂金9995",
  GLNC:"美黄金",SLNC:"美白银",PLNC:"美铂金",PANC:"美钯金",
  XAU:"伦敦金",XAG:"伦敦银",XAP:"伦敦铂",XPD:"伦敦钯",USDCNH:"美 元"
};

function buildAllCodes() {
  const codes = [...NORMAL_CODES];
  for (const p of RTG_PRODUCTS) {
    codes.push(p + "_PS", p + "_PB", p);
  }
  return codes;
}

// ========== 轻量 Protobuf 编解码 ==========
// Protobuf wire types
const WIRE_VARINT = 0;
const WIRE_64BIT = 1;
const WIRE_LENGTH = 2;

function encodeVarint(value) {
  const bytes = [];
  let v = value >>> 0; // 转无符号
  while (v > 127) {
    bytes.push((v & 0x7F) | 0x80);
    v >>>= 7;
  }
  bytes.push(v & 0x7F);
  return bytes;
}

function encodeTag(fieldNum, wireType) {
  return encodeVarint((fieldNum << 3) | wireType);
}

function encodeBytes(fieldNum, data) {
  const tag = encodeTag(fieldNum, WIRE_LENGTH);
  const len = encodeVarint(data.length);
  const result = new Uint8Array(tag.length + len.length + data.length);
  result.set(tag, 0);
  result.set(len, tag.length);
  result.set(data, tag.length + len.length);
  return result;
}

function encodeFieldVarint(fieldNum, value) {
  const tag = encodeTag(fieldNum, WIRE_VARINT);
  const val = encodeVarint(value);
  const result = new Uint8Array(tag.length + val.length);
  result.set(tag, 0);
  result.set(val, tag.length);
  return result;
}

function strToBytes(str) {
  return new TextEncoder().encode(str);
}

function bytesToStr(bytes) {
  return new TextDecoder().decode(bytes);
}

// 编码 QuotationMsg（我们只需要几个字段）
function encodeQuotationMsg(msg) {
  const parts = [];

  // field 1: msgid (varint)
  if (msg.msgid !== undefined) {
    parts.push(encodeFieldVarint(1, msg.msgid));
  }

  // field 2: seq (varint, int32)
  if (msg.seq !== undefined) {
    parts.push(encodeFieldVarint(2, msg.seq));
  }

  // field 8: jsonReq (length-delimited string)
  if (msg.jsonReq) {
    parts.push(encodeBytes(8, strToBytes(msg.jsonReq)));
  }

  // field 9: jsonResp (length-delimited string)
  if (msg.jsonResp) {
    parts.push(encodeBytes(9, strToBytes(msg.jsonResp)));
  }

  // 合并所有部分
  let totalLen = 0;
  for (const p of parts) totalLen += p.length;
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const p of parts) {
    result.set(p, offset);
    offset += p.length;
  }
  return result;
}

// 解码 Protobuf 通用函数
function decodeProtobuf(buf) {
  const result = {};
  let pos = 0;
  const view = buf instanceof Uint8Array ? buf : new Uint8Array(buf);

  while (pos < view.length) {
    // 读取 tag
    let tag = 0, shift = 0;
    while (pos < view.length) {
      const b = view[pos++];
      tag |= (b & 0x7F) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
    }

    const fieldNum = tag >>> 3;
    const wireType = tag & 0x07;

    if (wireType === WIRE_VARINT) {
      let value = 0, shift = 0;
      while (pos < view.length) {
        const b = view[pos++];
        value |= (b & 0x7F) << shift;
        if (!(b & 0x80)) break;
        shift += 7;
      }
      // 用第一个出现的值（因为 repeated 字段可能多次出现）
      if (result[fieldNum] === undefined) {
        result[fieldNum] = value;
      } else if (Array.isArray(result[fieldNum])) {
        result[fieldNum].push(value);
      } else {
        result[fieldNum] = [result[fieldNum], value];
      }
    } else if (wireType === WIRE_LENGTH) {
      // 读取长度
      let len = 0, shift = 0;
      while (pos < view.length) {
        const b = view[pos++];
        len |= (b & 0x7F) << shift;
        if (!(b & 0x80)) break;
        shift += 7;
      }
      // 读取数据
      const data = view.slice(pos, pos + len);
      pos += len;

      // 对于嵌套消息（response），递归解码
      if (fieldNum === 5 || fieldNum === 4) {
        const nested = decodeQuotationResponse(data);
        if (result[fieldNum] === undefined) {
          result[fieldNum] = [nested];
        } else {
          result[fieldNum].push(nested);
        }
      } else if (fieldNum === 8 || fieldNum === 9 || fieldNum === 10) {
        // JSON 字符串字段
        result[fieldNum] = bytesToStr(data);
      } else {
        result[fieldNum] = data;
      }
    } else if (wireType === WIRE_64BIT) {
      // double (8 bytes little-endian)
      const data = view.slice(pos, pos + 8);
      pos += 8;
      const float64 = new Float64Array(data.buffer.slice(data.byteOffset, data.byteOffset + 8));
      result[fieldNum] = float64[0];
    } else if (wireType === 5) {
      // 32-bit fixed
      const data = view.slice(pos, pos + 4);
      pos += 4;
      const float32 = new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + 4));
      result[fieldNum] = float32[0];
    }
  }

  return result;
}

// 解码 QuotationResponse（嵌套的子消息）
function decodeQuotationResponse(buf) {
  const fields = decodeProtobuf(buf);
  const resp = {};

  if (fields[1] !== undefined) resp.code = bytesToStr(fields[1]);  // string code
  if (fields[2] !== undefined) resp.volume = fields[2];   // double
  if (fields[3] !== undefined) resp.open = fields[3];     // double
  if (fields[4] !== undefined) resp.high = fields[4];     // double
  if (fields[5] !== undefined) resp.low = fields[5];      // double
  if (fields[6] !== undefined) resp.preClose = fields[6]; // double
  if (fields[7] !== undefined) resp.posi = fields[7];     // double
  if (fields[8] !== undefined) resp.rtLast = fields[8];   // double
  if (fields[9] !== undefined) resp.rtUpdown = fields[9]; // double
  if (fields[10] !== undefined) resp.rtUpdownRate = fields[10]; // double
  if (fields[11] !== undefined) resp.rtBidPrice = bytesToStr(fields[11]); // string
  if (fields[12] !== undefined) resp.rtAskPrice = bytesToStr(fields[12]); // string
  if (fields[13] !== undefined) resp.rtHighLimit = bytesToStr(fields[13]); // string
  if (fields[14] !== undefined) resp.rtLowLimit = bytesToStr(fields[14]); // string
  if (fields[15] !== undefined) resp.turnOver = fields[15]; // double
  if (fields[16] !== undefined) resp.time = bytesToStr(fields[16]); // string
  if (fields[17] !== undefined) resp.name = bytesToStr(fields[17]);  // string

  return resp;
}

// ========== 全局状态 ==========
let quotes = {};
let gwSocket = null;
let seq = 0;
let heartbeatTimer = null;

// ========== WebSocket 连接 ==========
function connectGateway() {
  console.log("[GW] 连接 " + WS_URL);
  gwSocket = new WebSocket(WS_URL, { rejectUnauthorized: false });

  gwSocket.on("open", () => {
    console.log("[GW] 已连接，发送认证...");
    authenticate();
  });

  gwSocket.on("message", (data) => {
    try {
      const buf = Buffer.isBuffer(data) ? new Uint8Array(data) : new Uint8Array(data);
      const msg = decodeProtobuf(buf);
      handleDecodedMsg(msg);
    } catch(e) {
      try {
        const j = JSON.parse(data.toString());
        console.log("[GW] JSON消息:", JSON.stringify(j).slice(0, 200));
      } catch(e2) {
        console.log("[GW] 解码失败:", e.message, "原始:", data.length || data.byteLength, "bytes");
      }
    }
  });

  gwSocket.on("close", (code, reason) => {
    console.log("[GW] 断开:", code, reason?.toString());
    clearInterval(heartbeatTimer);
    setTimeout(connectGateway, 3000);
  });

  gwSocket.on("error", (e) => console.error("[GW] 错误:", e.message));
}

// ========== 认证 ==========
function authenticate() {
  const bf = new Blowfish(AUTH.key, Blowfish.MODE.CBC, Blowfish.PADDING.PKCS5);
  bf.setIv(AUTH.iv);
  const plainText = AUTH.verifycode + AUTH.apptype + Date.now();
  const tokenBytes = bf.encode(plainText);
  const tokenArr = Array.from(new Uint8Array(tokenBytes));

  const msg = {
    msgid: MsgID.auth,
    seq: seq++,
    jsonReq: JSON.stringify({
      auth: { apptype: AUTH.apptype, token: tokenArr }
    })
  };

  const encoded = encodeQuotationMsg(msg);
  gwSocket.send(Buffer.from(encoded));
  console.log("[GW] 认证已发送, token长度:", tokenArr.length);
}

// ========== 消息处理 ==========
function handleDecodedMsg(msg) {
  // msg 的字段: 1=msgid, 2=seq, 5=response[], 8=jsonReq, 9=jsonResp, 10=errMsg
  const msgid = msg[1];

  if (msgid === undefined) {
    console.log("[GW] 收到无 msgid 的消息:", Object.keys(msg));
    return;
  }

  // 处理 jsonResp
  if (msg[9]) {
    try {
      const data = JSON.parse(msg[9]);
      if (msgid === MsgID.auth) {
        console.log("[GW] 认证响应:", JSON.stringify(data).slice(0, 300));
        if (data.status === 1 || data.auth || data.result !== false) {
          console.log("[GW] ✅ 认证成功！订阅行情...");
          startHeartbeat();
          subscribe();
        } else {
          console.log("[GW] ❌ 认证失败:", JSON.stringify(data));
        }
      }
      if (msgid === MsgID.quotation_broadcast || msgid === MsgID.latestQuotation) {
        processQuotes(data);
      }
      if (msgid === MsgID.codes_info_json) {
        console.log("[GW] 收到品种信息");
      }
    } catch(e) {
      console.log("[GW] JSON 解析失败:", e.message);
    }
  }

  // 处理二进制 response
  if (msg[5] && Array.isArray(msg[5])) {
    for (const r of msg[5]) {
      if (msgid === MsgID.auth) {
        console.log("[GW] ✅ 认证成功(二进制)！订阅行情...");
        startHeartbeat();
        subscribe();
      }
      if (msgid === MsgID.quotation_broadcast || msgid === MsgID.latestQuotation) {
        processQuoteResponse(r);
      }
    }
  }
}

function processQuotes(data) {
  const items = Array.isArray(data) ? data : [data];
  for (const item of items) {
    processQuoteItem(item);
  }
}

function processQuoteResponse(resp) {
  if (resp && resp.code) processQuoteItem(resp);
}

function processQuoteItem(item) {
  const code = item.code;
  if (!code) return;

  const price = {
    code,
    last: item.rtLast || item.last || 0,
    updown: item.rtUpdown || item.updown || 0,
    updownRate: item.rtUpdownRate || item.updownRate || 0,
    bidPrice: item.rtBidPrice || item.bidPrice,
    askPrice: item.rtAskPrice || item.askPrice,
    high: item.high || 0,
    low: item.low || 0,
    open: item.open || 0,
    volume: item.volume || 0,
    preClose: item.preClose || 0,
  };

  // 更新内部状态
  if (code.endsWith("_PS")) {
    const base = code.replace("_PS", "");
    if (!quotes[base]) quotes[base] = { code: base, cnname: PRODUCT_NAMES[base] || base };
    quotes[base].askPrice = price.last;
    quotes[base].askUpdown = price.updown;
    quotes[base].high = price.high || quotes[base].high;
    quotes[base].low = price.low || quotes[base].low;
  } else if (code.endsWith("_PB")) {
    const base = code.replace("_PB", "");
    if (!quotes[base]) quotes[base] = { code: base, cnname: PRODUCT_NAMES[base] || base };
    quotes[base].bidPrice = price.last;
    quotes[base].bidUpdown = price.updown;
  } else {
    quotes[code] = { ...price, cnname: PRODUCT_NAMES[code] || code };
  }

  broadcast({ type: "quote", data: price });
}

// ========== 订阅 ==========
function subscribe() {
  const codes = buildAllCodes();
  const msg = {
    msgid: MsgID.latestQuotation,
    seq: seq++,
    jsonReq: JSON.stringify({ codes, freq: [] })
  };
  gwSocket.send(Buffer.from(encodeQuotationMsg(msg)));
  console.log(`[GW] 已订阅 ${codes.length} 个品种`);
}

// ========== 心跳 ==========
function startHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (gwSocket?.readyState === WebSocket.OPEN) {
      const msg = { msgid: MsgID.heart_beat, seq: seq++ };
      gwSocket.send(Buffer.from(encodeQuotationMsg(msg)));
    }
  }, 30000);
}

// ========== HTTP 服务器 ==========
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });
const clients = new Set();

wss.on("connection", (ws) => {
  clients.add(ws);
  console.log(`[FE] 客户端连接 (${clients.size})`);
  ws.send(JSON.stringify({ type: "init", data: quotes }));
  ws.on("close", () => { clients.delete(ws); });
});

function broadcast(msg) {
  const str = JSON.stringify(msg);
  for (const c of clients) {
    if (c.readyState === WebSocket.OPEN) c.send(str);
  }
}

app.use(express.static(path.join(__dirname, "public")));
app.get("/api/quotes", (req, res) => res.json({ success: true, data: quotes }));

// ========== 启动 ==========
const PORT = 3456;
server.listen(PORT, () => {
  console.log(`[Server] http://localhost:${PORT}`);
  connectGateway();
});
