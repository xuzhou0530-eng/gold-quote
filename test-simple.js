// 最简测试 - 逐步排查
console.log("TEST-1: 开始");
console.log("TEST-2: 加载 ws...");
const WebSocket = require("ws");
console.log("TEST-3: ws OK");
console.log("TEST-4: 加载 blowfish...");
const { Blowfish } = require("egoroof-blowfish");
console.log("TEST-5: blowfish OK");
console.log("TEST-6: 加载 express...");
const express = require("express");
console.log("TEST-7: express OK");

console.log("TEST-8: 创建 HTTP 服务器...");
const http = require("http");
const path = require("path");
const app = express();
const server = http.createServer(app);
console.log("TEST-9: 服务器就绪，绑定端口...");

server.listen(3457, () => {
  console.log("TEST-10: ✅ 端口 3457 绑定成功！");
  console.log("TEST-11: 所有步骤通过，请打开 http://localhost:3457");
  // 5秒后自动退出
  setTimeout(() => { console.log("TEST-DONE"); process.exit(0); }, 5000);
});

server.on("error", (e) => {
  console.log("TEST-ERROR:", e.message);
  process.exit(1);
});
