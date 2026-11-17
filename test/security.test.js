// devcontrol — 安全与健壮性回归（评审发现的缺陷，每个都钉一条）
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { buildEnv } from "../src/exec.js";
import { compact } from "../src/mcp.js";
import { makeRepo, initFlow, BIN, closeProven } from "./helpers.js";

function startConsole(root, port = 20000 + Math.floor(Math.random() * 20000)) {
  const child = spawn(process.execPath, [BIN, "serve", "--port", String(port)], {
    env: { ...process.env, DEVCONTROL_ROOT: root },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`serve 未就绪：${out}`)), 10000);
    child.stdout.on("data", (d) => {
      out += d;
      if (out.includes("控制台")) {
        clearTimeout(timer);
        resolve({ base: `http://127.0.0.1:${port}`, child });
      }
    });
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`serve 退出 ${code}: ${out}`));
    });
  });
}

const post = (base, body, headers = {}) =>
  fetch(`${base}/api/owner`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

test("控制台拒绝跨站来源（CSRF）与非 JSON 的简单请求", async () => {
  const root = makeRepo();
  initFlow(root);
  const svc = await startConsole(root);
  try {
    const crossSite = await post(svc.base, { action: "intake", payload: { type: "requirement", title: "x", goal: "g", acceptance: ["npm test :: exit==0"] } }, { origin: "http://evil.example" });
    assert.equal(crossSite.status, 403);
    assert.equal((await crossSite.json()).code, "E_FORBIDDEN");

    // no-cors 的 text/plain 简单请求：浏览器不发预检，但这里必须拒
    const plain = await fetch(`${svc.base}/api/owner`, { method: "POST", headers: { "content-type": "text/plain" }, body: '{"action":"intake"}' });
    assert.equal(plain.status, 415);

    // 同源 / 无 Origin（curl、脚本）照旧可用
    const ok = await post(svc.base, { action: "intake", payload: { type: "requirement", title: "合法", goal: "g", acceptance: ["npm test :: exit==0"] } });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).ok, true);
  } finally {
    svc.child.kill();
  }
});

test("控制台：显式指定了不存在的 project 必须报错，不能静默写到默认仓库", async () => {
  const root = makeRepo();
  initFlow(root);
  const svc = await startConsole(root);
  try {
    const res = await post(svc.base, { action: "intake", project: "/definitely/not/registered", payload: { type: "requirement", title: "x", goal: "g", acceptance: ["npm test :: exit==0"] } });
    assert.equal(res.status, 400);
    const state = await fetch(`${svc.base}/api/state?project=${encodeURIComponent("/nope")}`);
    assert.equal(state.status, 400);
  } finally {
    svc.child.kill();
  }
});

test("控制台：一条畸形请求不会打死守护进程", async () => {
  const root = makeRepo();
  initFlow(root);
  const svc = await startConsole(root);
  try {
    await fetch(`${svc.base}/api/owner`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" }).catch(() => {});
    const after = await fetch(`${svc.base}/api/state`);
    assert.equal(after.status, 200, "控制台必须还活着");
    assert.equal(svc.child.exitCode, null);
  } finally {
    svc.child.kill();
  }
});

test("验收子进程的环境是白名单：父进程的密钥不会被透传", () => {
  process.env.DEVCONTROL_TEST_SECRET = "should-not-leak";
  try {
    const env = buildEnv();
    assert.equal(env.DEVCONTROL_TEST_SECRET, undefined);
    assert.equal(env.CI, "1");
    assert.ok(env.PATH, "PATH 要留着");
    assert.equal(buildEnv({ DEVCONTROL_TASK: "T-001" }).DEVCONTROL_TASK, "T-001", "显式传入的变量要生效");
  } finally {
    delete process.env.DEVCONTROL_TEST_SECRET;
  }
});

test("MCP 返回过大时仍然返回合法 JSON（不能 slice 字符串）", () => {
  const big = { memories: Array.from({ length: 20 }, (_, i) => ({ id: `M-${i}`, title: `经验 ${i}`, body: "很长的正文".repeat(200) })) };
  const text = compact(big);
  assert.ok(text.length <= 12000, `应当裁剪：${text.length}`);
  const parsed = JSON.parse(text); // 关键：必须能解析
  assert.equal(parsed.ok, true);
  assert.equal(parsed.truncated, true);
  assert.ok(parsed.memories.every((m) => m.body.length <= 240));
});

test("已 done 的任务不能再\"认领\"事后提交（防 --date 过继）", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const { taskClaim, taskClose } = await import("../src/gates.js");
  const { commitFiles } = await import("../src/git.js");
  const { newTask } = await import("./helpers.js");
  const { getTask } = await import("../src/store.js");
  const mission = newTask(db, root, reqId, { title: "先做完的" });
  taskClaim(db, root, { id: mission.id }, "agent");
  fs.writeFileSync(path.join(root, "src/a.js"), "export const a = \"mission\";\n");
  commitFiles(root, ["src/a.js"], `feat\n\nTask-Id: ${mission.id}`, { author: "agent" });
  await closeProven(db, root, { id: mission.id });
  assert.equal(getTask(db, mission.id).status, "done");

  // 另起一个任务，期间偷偷提交一条挂在「已完成任务」名下的越权改动
  const other = newTask(db, root, reqId, { title: "后来的", scope: ["src"] });
  taskClaim(db, root, { id: other.id }, "agent");
  fs.writeFileSync(path.join(root, "src/a.js"), "export const a = 2;\n");
  commitFiles(root, ["src/a.js"], `feat\n\nTask-Id: ${other.id}`, { author: "agent" });
  fs.mkdirSync(path.join(root, "evil"), { recursive: true });
  fs.writeFileSync(path.join(root, "evil/x.sh"), "echo pwn\n");
  commitFiles(root, ["evil/x.sh"], `chore\n\nTask-Id: ${mission.id}`, { author: "agent" });

  await assert.rejects(() => closeProven(db, root, { id: other.id }), (e) => e.code === "E_UNOWNED_COMMIT");
});
