// devcontrol — 「遇到歧义别猜」这句话，纯 CLI 用户也得能做到
//
// T-103 现场：AGENTS.md / SKILL.md 把「遇到歧义用 ask，不要猜」写成硬规则，
// 但 ask 只存在于 MCP。纯 CLI 的 Agent 照规矩办事，结论是「无路可走」——
// 它只剩两个选择：违反规则自己猜，或者去开控制台（而控制台是 Owner 的地盘）。
//
// 一样的问题在 bug 上报上：撞到不属于本任务的问题，之前只能写进 commit message。
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { makeRepo, initFlow, newTask, BIN } from "./helpers.js";
import { taskClaim } from "../src/gates.js";
import { getTask, listBugs, listQuestions } from "../src/store.js";

/** 失败 JSON 是多行的：从第一个 { 到最后一个 } 整段取，别只取第一行 */
function extractJson(stdout) {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** 跑一条 CLI，返回 { code, stdout, json }：失败也是 JSON（约定：ok 必在） */
function cli(root, ...args) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, DEVCONTROL_ROOT: root, DEVCONTROL_ACTOR: "agent" },
    });
    return { code: 0, stdout, json: extractJson(stdout) };
  } catch (error) {
    const stdout = String(error.stdout ?? "");
    return { code: error.status ?? 1, stdout, json: extractJson(stdout) };
  }
}

test("ask：不给 --task 时自动问到手上那条在办任务上", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  taskClaim(db, root, { id: t.id }, "agent");

  const out = cli(root, "ask", "这个字段该不该允许为空？");
  assert.equal(out.code, 0, out.stdout);
  const qs = listQuestions(db);
  assert.equal(qs.length, 1, "问题要真的落库");
  assert.equal(qs[0].task_id, t.id, "要问到在办任务头上");
  assert.match(qs[0].question, /允许为空/);
});

test("ask：任务会被暂停——问完继续猜是把纪律当摆设", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  taskClaim(db, root, { id: t.id }, "agent");
  cli(root, "ask", "选 A 还是 B？", "--options", "A,B");
  assert.equal(getTask(db, t.id).status, "parked", "问了就该停下等回答，而不是接着干");
});

test("ask：手上没活、也没给 --task —— 明确拒绝，不编一个任务号", () => {
  const root = makeRepo();
  initFlow(root);
  const out = cli(root, "ask", "没问题也要问？");
  assert.equal(out.code, 1);
  assert.equal(out.json?.code, "E_NO_TASK");
  assert.ok(out.json?.hint, "失败必须带 hint（统一契约）");
});

test("ask：未答问题最多 3 条，第 4 条只记事件（否则提问变成刷屏）", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  taskClaim(db, root, { id: t.id }, "agent");
  // 配额按「未答问题条数」算，不按任务状态算：任务 parked 了也照样能追问
  for (const q of ["问题一？", "问题二？", "问题三？"]) {
    const out = cli(root, "ask", q, "--task", t.id);
    assert.equal(out.code, 0, out.stdout);
    assert.match(out.stdout, /Q-\d+ {2}已提问/, `「${q}」应当真的建出问题：${out.stdout}`);
  }
  const fourth = cli(root, "ask", "问题四？", "--task", t.id);
  assert.equal(fourth.code, 0, "配额满不是错误，只是不再建新问题");
  assert.match(fourth.stdout, /配额已满/);
  assert.equal(listQuestions(db).length, 3, "第 4 条不该落库");
});

test("bug：上报成功，且必须带复现步骤（没有复现步骤的 bug 是抱怨）", () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  const bad = cli(root, "bug", "导出是空的");
  assert.equal(bad.code, 1, "没有 --repro 应当被拒");
  assert.equal(bad.json?.code, "E_CONTRACT");

  const ok = cli(root, "bug", "导出是空的", "--repro", "跑 devcontrol export", "--repro", "看到只有标题");
  assert.equal(ok.code, 0, ok.stdout);
  const bugs = listBugs(db);
  assert.equal(bugs.length, 1);
  assert.equal(bugs[0].title, "导出是空的");
  assert.equal(bugs[0].repro.length, 2, "两条复现步骤都要存下来");
});

test("bug：来源记成 agent，不能冒充 Owner", () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  cli(root, "bug", "x 崩了", "--repro", "点一下");
  assert.equal(listBugs(db)[0].source, "agent", "Agent 上报的是 agent，别伪装成 Owner 提的");
});

test("ask / bug 都进能力对照表——三重入口少一个，这里就红", async () => {
  const { CAPABILITIES } = await import("../src/capabilities.js");
  const ask = CAPABILITIES.find((c) => c.action === "ask");
  const bug = CAPABILITIES.find((c) => c.action === "bug.report");
  assert.ok(ask?.cli, "ask 必须有 CLI 入口");
  assert.ok(bug?.cli, "bug.report 必须有 CLI 入口");
  assert.ok(ask.cli.flags.includes("question"));
  assert.ok(bug.cli.flags.includes("repro"), "复现步骤是 bug 的必填项");
});