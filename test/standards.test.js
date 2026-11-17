// devcontrol — 规范：内核下发，但不执行
//
// 分工线是这么划的：
//   · 规范随任务下发 —— Owner 批准时看得见，Agent 领任务时拿到同一份
//   · 内核不判违规 —— 它只把事实数出来（改了多少行、动没动测试、留没留标记），
//     判断权留给 Owner。**工作台摆事实，人下结论。**
//   · 唯一硬拦的是 scope —— 那不是代码质量，是「这行代码属于哪个任务」的事实问题
//
// 这条线之前是反的：内核把四条质量规范都做成了拦截，Agent 收口被拦了才第一次
// 听说有这条规则，Owner 批准时也看不见。规范该说在前面，而不是罚在后面。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildStandards, compareStandards } from "../src/standards.js";
import { makeRepo, initFlow, newTask } from "./helpers.js";
import { taskClaim } from "../src/gates.js";

const SRC = path.join(import.meta.dirname, "..", "src");

test("契约里带着规范：规则清单 + 哪些是内核会拦的", () => {
  const root = makeRepo();
  initFlow(root);
  const body = JSON.parse(fs.readFileSync(path.join(root, ".devcontrol/contracts/P-001.json"), "utf8"));
  assert.ok(body.standards, "契约里必须有 standards");
  assert.ok(Array.isArray(body.standards.rules) && body.standards.rules.length >= 5);
  assert.deepEqual(body.standards.enforced, ["scope"], "硬拦的只有 scope 这一类");
  for (const r of body.standards.rules) {
    assert.ok(r.id && r.text && r.text.length > 4, `规范条目不完整：${JSON.stringify(r)}`);
  }
});

test("预算数字进条文（不是一句含糊的「别改太多」）", () => {
  const std = buildStandards({ budgetLines: 350 });
  assert.match(std.rules.find((r) => r.id === "budget").text, /350 行/);
});

test("Agent 领取任务时拿到这份规范", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  const claimed = taskClaim(db, root, { id: t.id }, "agent");
  assert.ok(claimed.standards?.rules?.length >= 5, "开工时就要知道边界在哪");
  assert.deepEqual(claimed.standards.enforced, ["scope"]);
});

test("enforced 里的每一条都真的有内核拦截对应（不能写了不拦）", () => {
  const codes = new Set();
  for (const f of fs.readdirSync(SRC).filter((x) => x.endsWith(".js"))) {
    const body = fs.readFileSync(path.join(SRC, f), "utf8");
    for (const m of body.matchAll(/fail\(\s*"([A-Z][A-Z0-9_]+)"/g)) codes.add(m[1]);
    for (const m of body.matchAll(/new DFError\(\s*"([A-Z][A-Z0-9_]+)"/g)) codes.add(m[1]);
  }
  // scope 这一类对应两个码：改动越界、新增文件越界
  assert.ok(codes.has("E_SCOPE_VIOLATION"), "scope 规范说了会拦，就必须真的有这条拦截");
  assert.ok(codes.has("E_UNREGISTERED_FILES"));
});

test("质量类规范不再有对应拦截（说了只下发，就不能偷偷罚）", () => {
  const codes = new Set();
  for (const f of fs.readdirSync(SRC).filter((x) => x.endsWith(".js"))) {
    const body = fs.readFileSync(path.join(SRC, f), "utf8");
    for (const m of body.matchAll(/fail\(\s*"([A-Z][A-Z0-9_]+)"/g)) codes.add(m[1]);
    for (const m of body.matchAll(/new DFError\(\s*"([A-Z][A-Z0-9_]+)"/g)) codes.add(m[1]);
  }
  assert.ok(!codes.has("E_LINT_TODO"), "标记残留不该再拦人");
  assert.ok(!codes.has("E_DIFF_BUDGET"), "行数预算不该再拦人");
  assert.ok(!codes.has("E_DEP_OR_TEST_TOUCH"), "改依赖/既有测试不该再拦人");
  assert.ok(!codes.has("E_TEST_CONFIG_TOUCH"), "改测试配置不该再拦人");
});

test("compareStandards：把观测到的和规范对成一张表", () => {
  const std = buildStandards({ budgetLines: 100 });
  const table = compareStandards(std, [
    { id: "budget", detail: "本任务改了 312 行 > 预算 100" },
    { id: "todo", detail: "留下 2 处标记" },
  ]);
  assert.equal(table.length, std.rules.length);
  const budget = table.find((r) => r.id === "budget");
  assert.match(budget.touched[0], /312 行/);
  assert.deepEqual(table.find((r) => r.id === "scope").touched, [], "没观测到 = 这条没问题");
});