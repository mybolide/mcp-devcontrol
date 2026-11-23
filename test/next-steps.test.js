// devcontrol — next 的每一步都必须「照抄能走通」
//
// 黑盒实测发现的问题：claim 之后 next 立刻说「继续做完 T-001 并收口」，
// 而此刻一行代码都还没写。照抄 → E_NO_DELIVERY。而那条报错的提示里
// 连 devcontrol run 都没提，于是「必须先跑测试留证据」这件事，
// 只能靠再犯一次错（E_NO_EVIDENCE）才学得到。
//
// 这不是文案问题：引导链是 Agent 唯一的行动依据，它把「写码 → 跑测试 → 提交」
// 整段跳过，等于让每个新 Agent 的第一轮都注定失败一次。
// 内核明明数得出来（提交链、证据表），就该按真相说下一步。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { makeRepo, initFlow, newTask, prove, BIN } from "./helpers.js";
import { bootstrap } from "../src/digest.js";
import { taskClaim } from "../src/gates.js";
import { commitFiles } from "../src/git.js";

function cli(root, ...args) {
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [BIN, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, DEVCONTROL_ROOT: root, DEVCONTROL_ACTOR: "agent" } }) };
  } catch (error) {
    return { code: error.status ?? 1, stdout: String(error.stdout ?? "") };
  }
}

test("刚领取、还没写码：next 说去干活，不是让你收口", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  taskClaim(db, root, { id: t.id }, "agent");

  const next = bootstrap(db, root).next;
  assert.equal(next.action, "task.work", `不该直接催收口（照抄必撞 E_NO_DELIVERY）：${JSON.stringify(next)}`);
  assert.match(next.why, /还没提交/);
  // 四步要按顺序摆出来，而不是只丢一句「继续做」
  assert.ok(next.steps?.length >= 3, `要给出完整顺序：${JSON.stringify(next.steps)}`);
  assert.ok(next.steps.some((s) => s.includes("devcontrol run --")), "「自己跑测试」这一步不能漏");
  assert.ok(next.steps.some((s) => s.includes("commit")), "提交这一步不能漏");
});

test("照抄 next 给的命令不会立刻撞墙（第一次就成功）", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  taskClaim(db, root, { id: t.id }, "agent");

  // 严格按 next.steps 的顺序做，中途不该有任何一步失败
  fs.writeFileSync(path.join(root, "src/a.js"), "export const a = 7;\n");
  const run = cli(root, "run", "--", "npm test");
  assert.equal(run.code, 0, run.stdout);
  const commit = cli(root, "commit", "-m", "feat: a");
  assert.equal(commit.code, 0, commit.stdout);

  // 这时 next 才该说收口，且给的正是那条命令
  const next = bootstrap(db, root).next;
  assert.equal(next.action, "task.close");
  assert.equal(next.cli, `devcontrol close ${t.id}`);
  const closed = cli(root, "close", t.id, "--summary", "夹具结论", "--changes", "夹具改动", "--limitations", "无");
  assert.equal(closed.code, 0, closed.stdout);
});

test("代码写了、证据有了、但还没提交：说的是「去提交」，不是「去写码」", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  taskClaim(db, root, { id: t.id }, "agent");
  fs.writeFileSync(path.join(root, "src/a.js"), "export const a = 8;\n");
  prove(db, root, t.id);

  const next = bootstrap(db, root).next;
  assert.equal(next.action, "task.work");
  assert.match(next.why, /还没提交/, `要指出差在哪一步：${next.why}`);
  assert.ok(!next.steps.some((s) => s.startsWith("写代码")), "代码已经写了，不该再让人去写");
});

test("已提交、但没留证据：说的是「去跑测试」，并且直接给出那条命令", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  taskClaim(db, root, { id: t.id }, "agent");
  fs.writeFileSync(path.join(root, "src/a.js"), "export const a = 9;\n");
  commitFiles(root, ["src/a.js"], `feat\n\nTask-Id: ${t.id}`, { author: "agent" });

  const next = bootstrap(db, root).next;
  assert.equal(next.action, "task.work");
  assert.match(next.why, /证据/);
  assert.equal(next.cli, "devcontrol run -- npm test", `该给的正是这条：${next.cli}`);
});

test("E_NO_DELIVERY 的提示要带上完整四步——它的下一步就是 run，不是「再试试」", async () => {
  const { hintFor } = await import("../src/hints.js");
  const hint = hintFor({ code: "E_NO_DELIVERY" });
  assert.match(hint, /devcontrol run --/, "漏了 run，人就只能靠再犯一次 E_NO_EVIDENCE 才学到");
  assert.match(hint, /commit/);
});

test("task.work 是 MCP 的合法动作：next 让它做，它调了不能报「非法枚举」", async () => {
  const { ACTIONS } = await import("../src/mcp.js");
  assert.ok(ACTIONS.includes("task.work"), "next.action 必须总是可调用的动作");
  assert.ok(ACTIONS.includes("wait"), "wait 同理");
});

test("在办时 actions 里既有 close 也有 work——两条路都要摆出来，别只给一条", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  taskClaim(db, root, { id: t.id }, "agent");
  const acts = bootstrap(db, root).actions;
  assert.ok(acts.includes("task.close"));
  assert.ok(acts.includes("task.work"));
});

test("内核只有一套顺序：next.steps 和 SKILL/hints 说的必须是同一个", async () => {
  // 早先 next.steps 说「run → commit → close」，SKILL 说「commit → run → close」，
  // hints 又是第三种。三处各说一套，Agent 照哪份都可能踩空——
  // 而它没有能力判断哪份是"更新的"。
  const fsx = await import("node:fs");
  const { execFileSync: run } = await import("node:child_process");
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  taskClaim(db, root, { id: t.id }, "agent");
  const steps = bootstrap(db, root).next.steps.join(" ");

  const iRun = steps.indexOf("devcontrol run --");
  const iCommit = steps.indexOf("devcontrol commit");
  const iClose = steps.indexOf("devcontrol close");
  assert.ok(iRun >= 0 && iCommit >= 0 && iClose >= 0, `三步都要在：${steps}`);
  assert.ok(iRun < iCommit && iCommit < iClose, `顺序必须是 run → commit → close：${steps}`);

  // SKILL 里同一句话也必须按这个顺序（run 出现在 commit 之前）
  const skill = fsx.readFileSync(new URL("../src/skill.js", import.meta.url), "utf8");
  const body = skill.slice(skill.indexOf("一轮的唯一流程"), skill.indexOf("Owner 的动作不在 MCP 里"));
  const sRun = body.indexOf("devcontrol run --");
  const sCommit = body.indexOf("devcontrol commit -m");
  assert.ok(sRun >= 0 && sCommit >= 0, "SKILL 的两步都要在");
  assert.ok(sRun < sCommit, "SKILL 也得先跑再提交，别和 next 各说一套");

  // E_NO_DELIVERY 的提示同理
  const { hintFor } = await import("../src/hints.js");
  const hint = hintFor({ code: "E_NO_DELIVERY" });
  assert.ok(hint.indexOf("devcontrol run --") < hint.indexOf("commit"), `hint 也要同一顺序：${hint}`);
  void run;
});
