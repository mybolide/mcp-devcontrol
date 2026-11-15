#!/usr/bin/env node
// 并发探针：多个 Agent 同时干活，内核会不会把它们锁死？
//
// 实测七件事：
//   ① 同一任务被 N 个 Agent 同时抢 —— 只能有一个成功（CAS）
//   ② scope 相交的任务同时抢 —— 后来者被拦，不会双开
//   ③ 不相关的任务可以并行 —— 一个在办不挡另一个
//   ④ 同一个 Actor 想同时拿两个任务 —— WIP=1 生效
//   ⑤ 冲突方还在办时，等待者仍被拦（拦截理由要正确）
//   ⑥ 冲突方逐个收口后，等待者能拿到 —— 没有持久锁死
//   ⑦ 全局判断：内核始终给得出下一步
//
// 用法：node scripts/concurrency-probe.mjs        （RACE_KEEP=1 保留临时目录）

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BIN = path.resolve(import.meta.dirname, "..", "bin", "devcontrol.js");
const PORT = 7900 + (process.pid % 300);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "devcontrol-race-"));
const env = { ...process.env, DEVCONTROL_ROOT: root };
let consoleProc = null;
let failures = 0;

const say = (m = "") => console.log(m);
const ok = (msg) => say(`   ✓ ${msg}`);
const bad = (msg) => {
  failures += 1;
  say(`   ✗ ${msg}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dc(args) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: root, env, encoding: "utf8" });
  return { code: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}
function must(args) {
  const r = dc(args);
  if (r.code !== 0) throw new Error(`devcontrol ${args.join(" ")} 失败\n${r.out}${r.err}`);
  return r.out;
}
const codeOf = (r) => (r.err.match(/^(E_[A-Z_]+)/m) ?? [])[1] ?? null;

/** 并发跑 N 个 claim，返回每个的结果 */
function raceClaim(taskId, actors) {
  return Promise.all(
    actors.map(
      (actor) =>
        new Promise((resolve) => {
          const child = spawn(process.execPath, [BIN, "task", "claim", taskId, "--actor", actor], { cwd: root, env });
          let out = "";
          let err = "";
          child.stdout.on("data", (d) => (out += d));
          child.stderr.on("data", (d) => (err += d));
          child.on("close", (code) => resolve({ actor, code, out, err }));
        }),
    ),
  );
}

/** 改文件 → 提交 → 收口 */
function finish(taskId, actor, file, body) {
  fs.writeFileSync(path.join(root, file), body);
  const c = dc(["commit", "-m", `feat: ${file}`, "--actor", actor]);
  if (c.code !== 0) return { ok: false, why: `提交失败：${c.err}` };
  const cl = dc(["close", taskId, "--actor", actor]);
  const passed = cl.code === 0 && cl.out.includes('"passed": true');
  return { ok: passed, why: `${cl.out}${cl.err}`.slice(0, 300) };
}

async function owner(action, payload) {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/owner`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, payload }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(`Owner ${action} 失败：${j.code} ${j.message}`);
  return j.result;
}

async function main() {
  say(`工作目录：${root}`);

  say("\n① 准备仓库并 init");
  spawnSync("git", ["init", "-q", "."], { cwd: root });
  spawnSync("git", ["config", "user.email", "race@local"], { cwd: root });
  spawnSync("git", ["config", "user.name", "race"], { cwd: root });
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "package.json"), '{\n  "name": "race",\n  "version": "1.0.0",\n  "scripts": { "test": "node -e \\"process.exit(0)\\"" }\n}\n');
  for (const f of ["a", "c", "d"]) fs.writeFileSync(path.join(root, `src/${f}.js`), `export const ${f} = 1;\n`);
  spawnSync("git", ["add", "-A"], { cwd: root });
  spawnSync("git", ["commit", "-qm", "init"], { cwd: root });
  must(["init", "--no-mcp"]);

  say("\n② 起控制台并批准需求");
  consoleProc = spawn(process.execPath, [BIN, "serve", "--port", String(PORT)], { cwd: root, env, stdio: "ignore" });
  for (let i = 0; i < 60; i += 1) {
    await sleep(150);
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/api/meta`)).ok) break;
    } catch {
      /* 还没起来 */
    }
  }
  const st = await (await fetch(`http://127.0.0.1:${PORT}/api/state`)).json();
  const pathId = st.paths[0].id;
  const fr = await owner("intake", { type: "requirement", title: "多 agent 并行", goal: "验证不锁死", acceptance: ["npm test :: exit==0"] });
  await owner("approve", { requirementId: fr.id, pathId });

  const mk = (title, scope) => must(["task", "create", "--req", fr.id, "--path", pathId, "--title", title, "--scope", scope]).match(/T-\d+/)[0];
  const tA = mk("改 a.js", "src/a.js");
  const tB = mk("改 src 全局（与 A/C 相交）", "src");
  const tC = mk("改 c.js（与 A 不相交）", "src/c.js");
  const tD = mk("改 d.js（另起的活）", "src/d.js");
  say(`   任务：A=${tA} B=${tB} C=${tC} D=${tD}`);

  say("\n③ 同一任务被 6 个 Agent 同时抢");
  const race = await raceClaim(tA, Array.from({ length: 6 }, (_, i) => `agent-${i + 1}`));
  const winners = race.filter((r) => r.code === 0);
  const losers = race.filter((r) => r.code !== 0);
  winners.length === 1 ? ok(`只有 1 个抢到（${winners[0].actor}）`) : bad(`${winners.length} 个同时抢到，CAS 失效`);
  const loserCodes = [...new Set(losers.map(codeOf))];
  loserCodes.every((c) => c === "E_CLAIMED_BY_OTHER") ? ok(`其余 ${losers.length} 个都被 E_CLAIMED_BY_OTHER 挡住`) : bad(`异常错误码：${loserCodes.join(",")}`);
  const holder = winners[0]?.actor ?? "agent-1";

  say("\n④ scope 相交的任务同时抢（A 在办，B 的 src 覆盖 A）");
  const raceB = await raceClaim(tB, ["agent-7", "agent-8", "agent-9"]);
  raceB.every((r) => r.code !== 0) ? ok("全部被拦，没有双开") : bad("有 Agent 抢到了相交 scope 的任务");
  const bCodes = [...new Set(raceB.map(codeOf))];
  bCodes.every((c) => c === "E_SCOPE_OVERLAP") ? ok("错误码一致：E_SCOPE_OVERLAP") : bad(`错误码：${bCodes.join(",")}`);

  say("\n⑤ 不相交的任务应当能并行（C 与 A 不冲突）");
  const raceC = await raceClaim(tC, ["agent-10"]);
  raceC[0].code === 0 ? ok("agent-10 拿到了 C，与 A 并行") : bad(`C 被误挡：${codeOf(raceC[0])}`);

  say("\n⑥ 同一个 Actor 想同时拿两个任务（WIP=1）");
  const dup = await raceClaim(tD, [holder]);
  dup[0].code !== 0 ? ok(`${holder} 已持有 A，拿不到 D（${codeOf(dup[0])}）`) : bad("同一 Actor 同时持有两个任务，WIP=1 失效");

  say("\n⑦ 冲突方还在办时，等待者仍被拦（理由要对）");
  const closeA = finish(tA, holder, "src/a.js", "export const a = 2;\n");
  closeA.ok ? ok("A 已收口（验收通过）") : bad(`A 收口失败：${closeA.why}`);
  const stillBlocked = await raceClaim(tB, ["agent-7"]);
  codeOf(stillBlocked[0]) === "E_SCOPE_OVERLAP" ? ok("B 仍被 C 挡住（src 覆盖 src/c.js，理应如此）") : bad(`拦截理由不对：${codeOf(stillBlocked[0])}`);

  say("\n⑧ 冲突方逐个收口后，等待者能拿到 —— 没有持久锁死");
  const closeC = finish(tC, "agent-10", "src/c.js", "export const c = 2;\n");
  closeC.ok ? ok("C 已收口") : bad(`C 收口失败：${closeC.why}`);
  const retryB = await raceClaim(tB, ["agent-7"]);
  retryB[0].code === 0 ? ok("agent-7 拿到了原先被挡的 B") : bad(`B 仍然拿不到：${codeOf(retryB[0])}`);

  say("\n⑨ 全局判断：内核始终给得出下一步");
  const finalState = await (await fetch(`http://127.0.0.1:${PORT}/api/state`)).json();
  const next = finalState.digest.next;
  next && next.action !== "wait" ? ok(`下一步：${next.action}`) : bad(`内核只能说 wait：${next?.why ?? ""}`);
  const c = finalState.digest.counts;
  say(`   状态：待办 ${c.todo} · 在办 ${c.doing} · 搁置 ${c.parked} · 完成 ${c.done}`);
  say(`   纪律三数：被拦 ${finalState.digest.stats.blocked} · 返工 ${finalState.digest.stats.rework} · 绕过 ${finalState.digest.stats.bypassed}`);

  say(failures === 0 ? "\n✅ 并发探针通过：多 Agent 并行不死锁，冲突被拦下且可恢复" : `\n❌ 有 ${failures} 项不符合预期`);
}

try {
  await main();
  process.exitCode = failures === 0 ? 0 : 1;
} catch (error) {
  console.error(`\n❌ 探针中断：${error.message}`);
  process.exitCode = 1;
} finally {
  if (consoleProc) {
    try {
      consoleProc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  if (process.env.RACE_KEEP !== "1") {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  } else {
    console.log(`临时目录已保留：${root}`);
  }
}
