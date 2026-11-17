// devcontrol — 预算：内核说的数必须和它判断用的数一致
//
// T-101 现场：claim 下发给 Agent 的规范写着「单个任务改动不超过 12000 行」，
// 同一个响应里的 budgetLines 却是 400，库里存的也是 400。
// Agent 照大数写，收口时被内核用它自己从没提过的 400 数落一顿。
//
// 这不是「默认值选得不对」的小事：内核自相矛盾时，Agent 无论怎么做都可能错，
// 而它没有能力分辨哪个数才是真的。所以这里守的是「三处说同一个数」。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { makeRepo, initFlow, newTask } from "./helpers.js";
import { taskClaim } from "../src/gates.js";
import { pathAdjust } from "../src/store.js";
import { openDb } from "../src/db.js";

const budgetOf = (db, id) => db.prepare("SELECT budget_lines FROM tasks WHERE id=?").get(id).budget_lines;

test("不指定预算时，任务的预算就是 Path 契约的预算（不是写死的 400）", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root); // helpers 给 P-001 写的是 1200
  const t = newTask(db, root, reqId);
  assert.equal(budgetOf(db, t.id), 1200, "默认应当继承 Path 契约，而不是库里那个 400");
});

test("Owner 调过 Path 预算后，新任务跟着走（不是只跟 init 那个 1200）", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  pathAdjust(db, root, { pathId: "P-001", budgetLines: 5000, reason: "这个项目一次改动就是大，放宽一点" });
  const t = newTask(db, root, reqId);
  assert.equal(budgetOf(db, t.id), 5000);
});

test("显式给了 budgetLines 就用给的——默认值不能盖掉人的话", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId, { budgetLines: 300 });
  assert.equal(budgetOf(db, t.id), 300);
});

test("claim 里的 budgetLines 和它下发的那条规范说的是同一个数", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  pathAdjust(db, root, { pathId: "P-001", budgetLines: 777, reason: "对齐检查：预算数字必须一致" });
  const t = newTask(db, root, reqId);
  const claimed = taskClaim(db, root, { id: t.id }, "agent");

  const rule = claimed.standards.rules.find((r) => r.id === "budget");
  assert.match(rule.text, /777 行/, `规范里应当是 777：${rule.text}`);
  assert.equal(claimed.budgetLines, 777, `响应里的数字要和规范一致，实际 ${claimed.budgetLines}`);
});

test("干净的库默认值也不是 400（写死在 schema 里，这病会原样复发）", () => {
  const root = makeRepo();
  const db = openDb(root); // 不经过 initFlow，直接用 schema 默认值
  const dflt = db.prepare("SELECT dflt_value FROM pragma_table_info('tasks') WHERE name='budget_lines'").get();
  assert.notEqual(Number(dflt.dflt_value), 400, "任务的预算默认值不该是 init 那个时代的 400");
  assert.equal(Number(dflt.dflt_value), 1200, `应当和 Path 的默认预算一致，实际 ${dflt.dflt_value}`);
});

test("超预算仍只是观测，不拦收口（预算从来不是安全边界）", () => {
  // 这条防的是「修默认值时顺手把它改成硬拦」。规则是：事实归内核，判断归人。
  const src = fs.readFileSync(new URL("../src/gates.js", import.meta.url), "utf8");
  const head = src.slice(src.indexOf("const curBudget"));
  const seg = head.slice(0, head.indexOf("const MARK"));
  assert.ok(seg.includes("observations.push"), "预算只该记 observation");
  assert.ok(!/fail\(\s*"E_[A-Z_]*BUDGET/.test(seg), "不该有预算专用的拦截错误码");
});
