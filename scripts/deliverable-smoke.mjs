#!/usr/bin/env node
// 一条命令看完整流程：init → Owner 批准 → 领取 → 改造 → 收口 → 发布
//
// 全程只用 devcontrol 自己的命令与 HTTP 接口：
//   · Agent 侧走 MCP（这样 bootstrap.next 给的参数是原样执行的，不是我们手写的）
//   · Owner 侧走控制台的 /api/owner
//   · 收口走 CLI（干净检出里重跑验收）
// 脚本里没有任何直接写 .devcontrol/state.db 的语句。
//
// 用法：node scripts/deliverable-smoke.mjs
//       SMOKE_KEEP=1 node scripts/deliverable-smoke.mjs   # 保留临时目录便于排查

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const BIN = path.resolve(import.meta.dirname, "..", "bin", "devcontrol.js");
const PORT = 7500 + (process.pid % 300);
const ACTOR = "smoke-agent";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "devcontrol-smoke-"));
const env = { ...process.env, DEVCONTROL_ROOT: root, DEVCONTROL_ACTOR: ACTOR };

let consoleProc = null;
let client = null;

const say = (m = "") => console.log(m);
const fail = (m) => {
  throw new Error(m);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: root, env, encoding: "utf8", ...opts });
  if (r.status !== 0) fail(`${cmd} ${args.join(" ")} 失败\n${r.stdout ?? ""}${r.stderr ?? ""}`);
  return (r.stdout ?? "").trim();
}
const dc = (...args) => run(process.execPath, [BIN, ...args]);
const git = (...args) => run("git", args);

async function owner(action, payload) {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/owner`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, payload }),
  });
  const j = await res.json();
  if (!j.ok) fail(`Owner 动作「${action}」失败：${j.code} ${j.message}`);
  return j.result;
}

async function agent(args) {
  const r = await client.callTool({ name: "devcontrol", arguments: args });
  const text = r.content?.map((c) => c.text).join("\n") ?? "";
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }
  return { isError: Boolean(r.isError), payload };
}

/** 读内核给的下一件事，并原样执行它（照抄 next.args 必须成功） */
async function followNext(label) {
  const { payload: digest } = await agent({ action: "bootstrap" });
  const next = digest.next;
  if (!next) fail(`${label}：bootstrap 没给出 next`);
  const hint = next.args?.id ?? next.args?.title ?? "";
  say(`   · ${label}：内核说 ${next.action}${hint ? ` ${hint}` : ""}`);
  const { isError, payload } = await agent({ action: next.action, ...(next.args ?? {}) });
  if (isError) fail(`${label}：照 next.args 执行 ${next.action} 失败 → ${payload.code} ${payload.message}`);
  return { next, payload, digest };
}

async function main() {
  say(`工作目录：${root}`);
  say("\n① 准备一个干净的仓库");
  git("init", "-q", ".");
  git("config", "user.email", "smoke@local");
  git("config", "user.name", "smoke");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "smoke", version: "1.0.0", scripts: { test: 'node -e "process.exit(0)"' } }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(root, "src/app.js"), "export const greeting = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "初始提交");
  say("   已建好 git 仓库与 src/app.js");

  say("\n② devcontrol init（纯 CLI 模式）");
  for (const line of dc("init", "--no-mcp").split("\n")) say(`   ${line}`);

  say("\n③ 起 Owner 控制台");
  consoleProc = spawn(process.execPath, [BIN, "serve", "--port", String(PORT)], { cwd: root, env, stdio: "ignore" });
  let up = false;
  for (let i = 0; i < 60 && !up; i += 1) {
    await sleep(150);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/meta`);
      up = res.ok;
    } catch {
      up = false;
    }
  }
  if (!up) fail(`控制台没起来：http://127.0.0.1:${PORT}/`);
  say(`   http://127.0.0.1:${PORT}/`);

  say("\n④ 连上 MCP（Agent 的入口）");
  client = new Client({ name: "deliverable-smoke", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [BIN, "mcp"], cwd: root, env: { ...env, DEVCONTROL_CONSOLE: "0" } }),
  );
  say("   已连接");

  say("\n⑤ 状态一：还没有任何需求");
  await followNext("没有需求");

  say("\n⑥ Owner 在控制台提需求");
  const fr1 = await owner("intake", { type: "requirement", title: "首页要显示问候语", goal: "打开页面能看到 greeting", acceptance: ["npm test :: exit==0"] });
  say(`   需求 ${fr1.id} 已登记（草稿）`);

  say("\n⑦ 状态二：需求待批准");
  await followNext("需求待批准");

  say("\n⑧ Owner 批准需求（契约随之进 git）");
  const state = await (await fetch(`http://127.0.0.1:${PORT}/api/state`)).json();
  const pathId = state.paths[0]?.id;
  if (!pathId) fail("init 没有生成 Path");
  const approved = await owner("approve", { requirementId: fr1.id, pathId });
  say(`   批准 ${fr1.id} + ${pathId}，契约提交 ${String(approved.contractCommit).slice(0, 8)}`);

  say("\n⑨ 状态三：有已批准需求，但还没有任务");
  const made = await followNext("该拆任务了");
  const t1 = made.payload.id;
  if (!t1) fail("next 说建任务，但没有返回任务号");
  say(`   任务 ${t1}：${made.payload.title}`);

  say("\n⑩ 状态四：任务可领取");
  const claimed = await followNext("该领任务了");
  say(`   已领取 ${claimed.payload.id}，允许改：${JSON.stringify(claimed.payload.scope)}`);

  say("\n⑪ 改代码 → 提交 → 收口（干净检出里重跑验收）");
  fs.writeFileSync(path.join(root, "src/app.js"), "export const greeting = 2;\n");
  say(`   ${dc("commit", "-m", "feat: 问候语改成 2")}`);
  const closed = JSON.parse(dc("close", t1));
  if (!closed.runs?.every((r) => r.passed)) fail(`收口失败：${JSON.stringify(closed)}`);
  say(`   ${t1} 已完成：${closed.lines} 行 / ${closed.files} 个文件 / 验收 exit ${closed.runs[0].exit}`);

  say("\n⑫ 第二个需求复用同一条 Path（不需要手工建 Path）");
  const fr2 = await owner("intake", { type: "requirement", title: "问候语再加一句", goal: "验证第二条需求能直接开工", acceptance: ["npm test :: exit==0"] });
  await owner("approve", { requirementId: fr2.id, pathId });
  say(`   ${fr2.id} 批准在同一条 Path ${pathId} 上`);
  const t2res = await agent({
    action: "task.create",
    requirementId: fr2.id,
    pathId,
    kind: "fix",
    title: "问候语追加一句",
    scope: ["src/app.js"],
    acceptance: [{ deriveFrom: 0, assertion: "npm test :: exit==0" }],
  });
  if (t2res.isError) fail(`建第二个任务失败：${t2res.payload.code} ${t2res.payload.message}`);
  const t2 = t2res.payload.id;
  say(`   任务 ${t2}（类型 ${t2res.payload.kind}）`);
  const claim2 = await agent({ action: "task.claim", id: t2 });
  if (claim2.isError) fail(`领取 ${t2} 失败：${claim2.payload.code} ${claim2.payload.message}`);
  fs.writeFileSync(path.join(root, "src/app.js"), "export const greeting = 3; // 第二句\n");
  say(`   ${dc("commit", "-m", "fix: 问候语追加一句")}`);
  const closed2 = JSON.parse(dc("close", t2));
  if (!closed2.runs?.every((r) => r.passed)) fail(`第二个任务收口失败：${JSON.stringify(closed2)}`);
  say(`   ${t2} 已完成`);

  say("\n⑬ 发布");
  const rel = JSON.parse(dc("release", "create", "v0.1"));
  dc("release", "plan", rel.id, t1, t2);
  const shipped = JSON.parse(dc("release", "ship", rel.id));
  say(`   ${rel.id} 已发布（${shipped.tasks?.length ?? shipped.taskCount ?? 0} 个任务）`);

  say("\n⑭ 对账");
  const doctor = dc("doctor");
  say(doctor.split("\n").map((l) => `   ${l}`).join("\n"));
  if (doctor.includes("ERROR")) fail("doctor 报了 ERROR");

  say("\n✅ 全流程通过：init → 批准 → 领取 → 改造 → 收口 → 第二个需求复用 Path → 发布");
}

try {
  await main();
  process.exitCode = 0;
} catch (error) {
  console.error(`\n❌ 流程中断：${error.message}`);
  process.exitCode = 1;
} finally {
  try {
    await client?.close();
  } catch {
    /* ignore */
  }
  if (consoleProc) {
    try {
      consoleProc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  if (process.env.SMOKE_KEEP !== "1") {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  } else {
    console.log(`临时目录已保留：${root}`);
  }
}
