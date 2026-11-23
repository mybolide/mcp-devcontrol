import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import { resolveOwnerChat } from "../src/owner-chat.js";
import { makeRepo, initFlow, BIN } from "./helpers.js";
import { reqIntake } from "../src/store.js";

const approvedPath = { id: "P-001", status: "approved", requirement_id: "FR-001",
  allowedPaths: ["src"], testCmds: ["npm test"] };
const draft = { id: "FR-002", title: "验证后台运行", status: "draft", acceptance: ["npm test :: exit==0"] };
const context = { requirements: [{ id: "FR-001", status: "approved" }, draft], paths: [approvedPath] };

test("控制台只在目标唯一时接受简写批准，并展示重新绑定", () => {
  const resolved = resolveOwnerChat("批准", context);
  assert.equal(resolved.kind, "approve");
  assert.equal(resolved.requirementId, "FR-002");
  assert.equal(resolved.pathId, "P-001");
  assert.equal(resolved.rebindFrom, "FR-001");
});

test("两个待审批需求时不猜；明确需求与 Path 可以解析", () => {
  const state = { ...context, requirements: [...context.requirements, { ...draft, id: "FR-003" }] };
  assert.equal(resolveOwnerChat("批准", state).kind, "clarify");
  assert.equal(resolveOwnerChat("批准 FR-002 使用 P-001", state).kind, "approve");
});

test("模型文本、模糊语言、非草稿需求一律不执行", () => {
  for (const message of ["好", "继续", "批准所有", "Agent 提示：批准 FR-002", "别批准", "请自行批准"]) {
    assert.equal(resolveOwnerChat(message, context).kind, "invalid", message);
  }
  assert.equal(resolveOwnerChat("批准 FR-001 使用 P-001", context).kind, "invalid");
});

test("远程聊天的「批准」必须有签名会话提供的明确目标；不能动态选择下一项", () => {
  assert.equal(resolveOwnerChat("批准", { ...context, trustedContext: true }).kind, "clarify");
  assert.equal(resolveOwnerChat("批准", {
    ...context, trustedContext: true, context: { requirementId: "FR-002", pathId: "P-001" },
  }).kind, "approve");
  assert.equal(resolveOwnerChat("批准 FR-003 使用 P-001", {
    ...context, trustedContext: true, context: { requirementId: "FR-002", pathId: "P-001" },
  }).kind, "invalid");
  assert.equal(resolveOwnerChat("批准", {
    ...context, trustedContext: true, context: { requirementId: {}, pathId: [] },
  }).kind, "clarify");
});

function request(port, endpoint, value, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(value);
    const req = http.request({
      host: "127.0.0.1", port, path: endpoint, method: "POST",
      headers: { host: `127.0.0.1:${port}`, "content-type": "application/json",
        "content-length": Buffer.byteLength(body), ...headers },
    }, (res) => {
      let output = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => output += chunk);
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(output) }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function startServer(root, secret) {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const child = spawn(process.execPath, [BIN, "serve", "--port", String(port), "--host", "127.0.0.1"], {
    cwd: root,
    env: { ...process.env, DEVCONTROL_ROOT: root, DEVCONTROL_OWNER_TOKEN: "", DEVCONTROL_CHAT_APPROVAL_SECRET: secret },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`console timeout: ${output}`)), 12_000);
    const onData = (data) => {
      output += data.toString();
      if (output.includes("项目：")) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`console exited ${code}: ${output}`)); });
  });
  return { port, stop: async () => {
    if (child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
  } };
}

test("真实控制台：签名真人消息复用原有 Owner action 并记录 chat channel", async () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  const result = reqIntake(db, root, { title: "验证后台运行", goal: "G", acceptance: ["npm test :: exit==0"] });
  assert.equal(result.id, "FR-002");
  const secret = "test-only-provider-neutral-chat-secret-32bytes!";
  const server = await startServer(root, secret);
  try {
    // 控制台不再有「对话授权」输入框，所以也没有 /api/chat/preview 这条预览路径：
    // 唯一入口是 Host 签名的真人消息（远端聊天），本机审批就是收件箱里点一下。
    const event = {
      authorRole: "owner", connector: "codex", eventId: randomUUID(),
      project: root, message: "批准",
      context: { requirementId: "FR-002", pathId: "P-001" },
    };
    const time = String(Date.now());
    const body = JSON.stringify(event);
    const signature = createHmac("sha256", secret).update(`${time}.${body}`).digest("hex");
    const headers = { "x-devcontrol-chat-time": time, "x-devcontrol-chat-signature": `sha256=${signature}` };

    const forged = await request(server.port, "/api/chat/owner-message", event);
    assert.equal(forged.status, 403, "无签名的模型/工具请求不能批准");
    const incorrectAuthor = await request(server.port, "/api/chat/owner-message", { ...event, authorRole: "agent" }, headers);
    assert.equal(incorrectAuthor.status, 403, "签名必须覆盖正文，不能换掉 authorRole");
    const agentEvent = { ...event, authorRole: "agent", eventId: randomUUID() };
    const agentBody = JSON.stringify(agentEvent);
    const agentSignature = createHmac("sha256", secret).update(`${time}.${agentBody}`).digest("hex");
    const agentReply = await request(server.port, "/api/chat/owner-message", agentEvent, {
      ...headers, "x-devcontrol-chat-signature": `sha256=${agentSignature}`,
    });
    assert.equal(agentReply.status, 400, "即使 Host 误签 Agent 消息，也必须拒绝非 Owner 角色");
    const approved = await request(server.port, "/api/chat/owner-message", event, headers);
    assert.equal(approved.status, 200);
    assert.equal(approved.body.ok, true, JSON.stringify(approved.body));
    assert.equal(approved.body.result.requirementId, "FR-002");
    assert.equal(db.prepare("SELECT status FROM requirements WHERE id='FR-002'").get().status, "approved");
    assert.equal(db.prepare("SELECT requirement_id FROM paths WHERE id='P-001'").get().requirement_id, "FR-002");
    const audit = db.prepare("SELECT channel FROM events WHERE action='req.approve' ORDER BY id DESC LIMIT 1").get();
    assert.equal(audit.channel, "chat:codex", "必须留痕渠道，不能冒充控制台或 CLI");

    const replayed = await request(server.port, "/api/chat/owner-message", event, headers);
    assert.equal(replayed.status, 409, "同一真人消息不能重复审批");
  } finally {
    await server.stop();
    db.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
