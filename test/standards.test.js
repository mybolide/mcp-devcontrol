// devcontrol — 规范要写在契约里，不能只藏在内核代码里
//
// 之前这几条规范（不许改既有测试、不许超预算、不许留 TODO…）散在 gates.js 里：
// Owner 批准 Path 时看不见、Agent 开工时不知道，被拦了才第一次听说。
// 更糟的是有些规范（比如「TODO 必须带任务号」）连内核自己的文案都会被误伤。
//
// 现在它们被冻进契约：Owner 批准时能看见自己要守什么，Agent claim 时拿到同一份，
// 被拦时错误码能对上其中一条。这是 Jira 没有的那一半——Jira 只管「功能做对了没」，
// 不管「代码写成什么样」；我们这边没人 review，只能由内核兜。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildStandards, ruleOf } from "../src/standards.js";
import { makeRepo, initFlow, newTask } from "./helpers.js";
import { openDb } from "../src/db.js";
import { taskClaim } from "../src/gates.js";

const SRC = path.join(import.meta.dirname, "..", "src");

test("契约里带着规范清单，每条都有 code 和 rule", () => {
  const root = makeRepo();
  initFlow(root);
  const file = path.join(root, ".devcontrol/contracts/P-001.json");
  assert.ok(fs.existsSync(file), "批准时应该已经把契约提交出来");
  const body = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(Array.isArray(body.standards), "契约里必须有 standards");
  assert.ok(body.standards.length >= 5, `规范条目太少：${body.standards.length}`);
  for (const s of body.standards) {
    assert.match(s.code, /^E_[A-Z_]+$/, `规范条目缺错误码：${JSON.stringify(s)}`);
    assert.ok(s.rule && s.rule.length > 4, `规范条目缺说明：${JSON.stringify(s)}`);
  }
});

test("预算数字进规范原文（不是一句含糊的「别改太多」）", () => {
  const withBudget = buildStandards({ budgetLines: 350 }).find((s) => s.code === "E_DIFF_BUDGET");
  assert.match(withBudget.rule, /350 行/);
});

test("Agent 领取任务时也拿到这份规范", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  const claimed = taskClaim(db, root, { id: t.id }, "agent");
  assert.ok(Array.isArray(claimed.standards) && claimed.standards.length >= 5, "开工时就要知道边界在哪");
  assert.ok(claimed.standards.some((s) => s.code === "E_DIFF_BUDGET"));
});

test("每条规范都对应一个内核真的会抛的错误码（不许写安慰性条款）", () => {
  const codes = new Set();
  for (const f of fs.readdirSync(SRC).filter((x) => x.endsWith(".js"))) {
    const body = fs.readFileSync(path.join(SRC, f), "utf8");
    for (const m of body.matchAll(/fail\(\s*"([A-Z][A-Z0-9_]+)"/g)) codes.add(m[1]);
    for (const m of body.matchAll(/new DFError\(\s*"([A-Z][A-Z0-9_]+)"/g)) codes.add(m[1]);
  }
  const ghosts = buildStandards({ budgetLines: 100 }).filter((s) => !codes.has(s.code));
  assert.deepEqual(ghosts.map((s) => s.code), [], "这些规范写的错误码内核根本不会抛，等于没写");
});

test("ruleOf 能把错误码翻回规范原文", () => {
  assert.match(ruleOf("E_LINT_TODO"), /TODO/);
  assert.equal(ruleOf("NOT_A_CODE"), null);
});