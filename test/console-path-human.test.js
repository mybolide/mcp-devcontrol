// devcontrol — 收件箱给人看：冻结命令必须带一版人话标题
//
// 早先收件箱直接贴 `cargo test -p agent-studio-ipc --locked …`，人读不出这条 Path
// 到底要守什么，只能盯着屏幕猜。前端不会自己翻译命令（那等于把规则复制一份到页面里），
// 所以人话标题由内核算好、随 /api/state 一起给出去——这个测试就钉这条出口。
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { makeRepo, initFlow, BIN } from "./helpers.js";

const PORT = 44000 + Math.floor(Math.random() * 6000);

function startConsole(root, port = PORT) {
  const child = spawn(process.execPath, [BIN, "serve", "--port", String(port), "--host", "127.0.0.1"], {
    cwd: root,
    env: { ...process.env, DEVCONTROL_ROOT: root, DEVCONTROL_OWNER_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`serve 未就绪：${out}`)), 15000);
    const onData = (d) => {
      out += d.toString();
      if (out.includes("项目：")) {
        clearTimeout(timer);
        resolve({ port, stop: () => child.kill() });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`serve 退出 ${code}：${out}`));
    });
  });
}

const get = (port, path) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "GET", headers: { host: `127.0.0.1:${port}` } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, json: () => JSON.parse(body || "{}") }));
    });
    req.on("error", reject);
    req.end();
  });

test("/api/state 的 Path 带人话命令：原始命令仍保留给机器", async () => {
  const root = makeRepo();
  initFlow(root, { testCmd: "cargo test -p agent-studio-ipc --locked" });

  const srv = await startConsole(root);
  try {
    const r = await get(srv.port, "/api/state");
    assert.equal(r.status, 200);
    const p = r.json().paths[0];
    assert.deepEqual(p.testCmds, ["cargo test -p agent-studio-ipc --locked"], "原始命令不能丢：CLI/机器还要靠它跑验收");
    assert.deepEqual(p.testCmdsHuman, ["跑通 agent-studio-ipc 的测试"], "页面拿到的必须是翻译过的人话");
  } finally {
    srv.stop();
  }
});
