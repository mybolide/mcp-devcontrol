// devcontrol — MCP 是主入口：失败的样子必须和 CLI 完全一致
//
// 为什么单开一组：Agent 九成时间走 MCP，不走 CLI。2026-11 发布前实测发现
// MCP 的失败 payload 里**没有 hint**——同一个 E_NEED_APPROVED，CLI 告诉你
// 「等 Owner 批准」，MCP 只丢一个错误码。也就是说疏漏恰好落在最常走的那条路上，
// 而所有针对 CLI 的测试都是绿的。
// 所以这里直接起真的 MCP stdio 进程，按协议走一遍。
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { makeRepo, initFlow, BIN } from "./helpers.js";

/** 最小 MCP 客户端：initialize → tools/list → tools/call */
function startMcp(root) {
  const child = spawn(process.execPath, [BIN, "mcp"], {
    cwd: root,
    env: { ...process.env, DEVCONTROL_ROOT: root, DEVCONTROL_ACTOR: "mcp-probe", DEVCONTROL_CONSOLE: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const waiters = new Map();
  let buf = "";
  let seq = 0;
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const w = waiters.get(msg.id);
      if (w) {
        waiters.delete(msg.id);
        w(msg);
      }
    }
  });
  child.stderr.on("data", () => {});
  const request = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      waiters.set(id, resolve);
      setTimeout(() => {
        if (waiters.delete(id)) reject(new Error(`MCP 超时：${method}`));
      }, 20000);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const notify = (method, params = {}) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  return { child, request, notify };
}

async function boot(root) {
  const mcp = startMcp(root);
  await mcp.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "probe", version: "1" },
  });
  mcp.notify("notifications/initialized");
  const tools = await mcp.request("tools/list", {});
  const name = tools.result.tools[0].name;
  const call = async (args) => {
    const r = await mcp.request("tools/call", { name, arguments: args });
    const text = r.result?.content?.[0]?.text ?? "{}";
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    return { isError: Boolean(r.result?.isError), json };
  };
  return { mcp, call, tools };
}

test("MCP 能握手、能列出工具（发布前必须真的连得上）", async () => {
  const root = makeRepo();
  initFlow(root);
  const { mcp, tools } = await boot(root);
  try {
    assert.deepEqual(
      tools.result.tools.map((tool) => tool.name).sort(),
      ["devcontrol", "devcontrol_request_owner_approval"],
      "一个 Agent 纪律工具 + 一个必须经客户端真人确认的审批申请工具",
    );
    const requestTool = tools.result.tools.find((tool) => tool.name === "devcontrol_request_owner_approval");
    assert.equal(requestTool.inputSchema?.properties?.requirementId?.type, "string");
    assert.equal(requestTool.inputSchema?.properties?.pathId?.type, "string");
    assert.ok(!Object.hasOwn(requestTool.inputSchema.properties, "approved"), "工具不得接收 Agent 自填的批准标记");
  } finally {
    mcp.child.kill();
  }
});

test("MCP 的失败和 CLI 一样：ok=false + code + message + data + hint", async () => {
  const root = makeRepo();
  initFlow(root);
  const { mcp, call } = await boot(root);
  try {
    // 需求未批准 → E_NEED_APPROVED
    const bad = await call({ action: "task.create", requirementId: "FR-999", pathId: "P-001", title: "x" });
    assert.equal(bad.isError, true, "失败应标记为 MCP error");
    assert.equal(bad.json.ok, false);
    assert.ok(bad.json.code, "必须带 code");
    assert.ok(bad.json.message, "必须带 message");
    assert.ok("data" in bad.json, "必须带 data 字段（可以为 null）");
    assert.ok(bad.json.hint, `MCP 失败必须带 hint（和 CLI 一致），实际拿到：${JSON.stringify(bad.json)}`);
  } finally {
    mcp.child.kill();
  }
});

test("MCP 的成功 payload 就是内核摘要本身，不带 isError", async () => {
  const root = makeRepo();
  initFlow(root);
  const { mcp, call } = await boot(root);
  try {
    const ok = await call({ action: "bootstrap" });
    assert.equal(ok.isError, false);
    assert.equal(ok.json.ok === false, false, "成功不该带 ok:false");
    assert.ok(Array.isArray(ok.json.actions), "bootstrap 应返回 actions");
    assert.ok("next" in ok.json, "bootstrap 应返回 next");
  } finally {
    mcp.child.kill();
  }
});

test("MCP 缺参数时报得清楚，不会漏 SQLite 内部错误", async () => {
  const root = makeRepo();
  initFlow(root);
  const { mcp, call } = await boot(root);
  try {
    const bad = await call({ action: "task.claim" });
    assert.equal(bad.json.ok, false);
    assert.match(bad.json.message, /缺少参数/, "应指出缺哪个参数");
    assert.ok(bad.json.hint, "缺参数也要给 hint");
  } finally {
    mcp.child.kill();
  }
});
test("MCP 也能交测试证据：evidence.record 缺 command 会被明确拒绝", async () => {
  const root = makeRepo();
  initFlow(root);
  const { mcp, call } = await boot(root);
  try {
    const bad = await call({ action: "evidence.record", exit: 0 });
    assert.equal(bad.json.ok, false);
    assert.match(bad.json.message, /缺少参数/);
    assert.ok(bad.json.hint);
  } finally {
    mcp.child.kill();
  }
});

test("没有在办任务时交证据：报 E_NO_TASK，不静默丢进黑洞", async () => {
  const root = makeRepo();
  initFlow(root);
  const { mcp, call } = await boot(root);
  try {
    const bad = await call({ action: "evidence.record", command: "npm test", exit: 0 });
    assert.equal(bad.json.ok, false);
    assert.equal(bad.json.code, "E_NO_TASK", `实际：${JSON.stringify(bad.json)}`);
  } finally {
    mcp.child.kill();
  }
});
