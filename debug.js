// 诊断脚本 - 逐步排查 server.js 卡在哪里
console.log("[1] 开始诊断...");

try {
  console.log("[2] 加载 ws...");
  const WebSocket = require("ws");
  console.log("[2] ws OK");
} catch(e) {
  console.log("[2] ws FAIL:", e.message);
}

try {
  console.log("[3] 加载 protobufjs...");
  const protobuf = require("protobufjs");
  console.log("[3] protobufjs OK");
} catch(e) {
  console.log("[3] protobufjs FAIL:", e.message);
}

try {
  console.log("[4] 加载 egoroof-blowfish...");
  const { Blowfish } = require("egoroof-blowfish");
  console.log("[4] blowfish OK, Blowfish type:", typeof Blowfish);
} catch(e) {
  console.log("[4] blowfish FAIL:", e.message);
}

try {
  console.log("[5] 加载 express...");
  const express = require("express");
  console.log("[5] express OK");
} catch(e) {
  console.log("[5] express FAIL:", e.message);
}

// === Protobuf 测试 ===
console.log("[6] 构建 Protobuf 定义...");
const protobuf = require("protobufjs");

try {
  const protoRoot = protobuf.Root.fromJSON({
    nested: {
      jadegold: { nested: { msg: { nested: { quotation: { nested: { pbv2: {
        nested: {
          QuoteMsgID: {
            values: {
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
              qry_option_info: 80
            }
          },
          QuotationRequest: {
            fields: {
              codes: { rule: "repeated", type: "string", id: 1 },
              freq: { rule: "repeated", type: "int32", id: 2 }
            }
          },
          QuotationResponse: {
            fields: {
              code: { type: "string", id: 1 },
              volume: { type: "double", id: 2 },
              open: { type: "double", id: 3 },
              high: { type: "double", id: 4 },
              low: { type: "double", id: 5 },
              preClose: { type: "double", id: 6 },
              posi: { type: "double", id: 7 },
              rtLast: { type: "double", id: 8 },
              rtUpdown: { type: "double", id: 9 },
              rtUpdownRate: { type: "double", id: 10 },
              rtBidPrice: { type: "string", id: 11 },
              rtAskPrice: { type: "string", id: 12 },
              rtHighLimit: { type: "string", id: 13 },
              rtLowLimit: { type: "string", id: 14 },
              turnOver: { type: "double", id: 15 },
              time: { type: "string", id: 16 },
              name: { type: "string", id: 17 }
            }
          },
          QuotationMsg: {
            fields: {
              msgid: { type: "QuoteMsgID", id: 1 },
              seq: { type: "int32", id: 2 },
              request: { type: "QuotationRequest", id: 4 },
              response: { rule: "repeated", type: "QuotationResponse", id: 5 },
              jsonReq: { type: "string", id: 8 },
              jsonResp: { type: "string", id: 9 },
              errMsg: { type: "string", id: 10 }
            }
          }
        }
      } } } } } } }
    }
  });
  console.log("[6] Protobuf 定义 OK");

  const QuotationMsg = protoRoot.lookupType("jadegold.msg.quotation.pbv2.QuotationMsg");
  console.log("[7] lookupType OK:", QuotationMsg.name);

  const QuoteMsgID = protoRoot.lookupEnum("jadegold.msg.quotation.pbv2.QuoteMsgID");
  console.log("[8] lookupEnum OK, auth=", QuoteMsgID.values.auth);

  // 测试 encode
  const testMsg = QuotationMsg.create({
    msgid: 32,
    seq: 0,
    jsonReq: JSON.stringify({ auth: { apptype: "rtj", token: [] } })
  });
  const encoded = QuotationMsg.encode(testMsg).finish();
  console.log("[9] encode OK, length:", encoded.length);

} catch(e) {
  console.log("[PROTO ERROR]", e.message);
  console.log("[PROTO STACK]", e.stack);
}

console.log("[10] 诊断完成");
