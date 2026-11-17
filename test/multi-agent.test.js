// devcontrol — 多 Agent 并行：相交 ≠ 冲突
//
// 真实事故（supplier-hub 内测）：三个 Agent 想同时干活，两个被 E_SCOPE_OVERLAP 挡住。
// 原因是它们的 scope 里都带 `test/`——谁都要写测试——而当时的判据是「目录相交就拦」。
// 结果这个号称支持多 Agent 的工具，实际上多个 Agent 永远没法同时开工。
//
// 正确判据：**一方完全落在另一方地盘里才算冲突**。
// 一个改 src/model、一个改 src/rating，共享 test/ 只是提醒「别改同一个文件」。
import test from "node:test";
import assert from "node:assert/strict";
import { makeRepo, initFlow, newTask, prove } from "./helpers.js";
import { conflicts, taskClaim, taskClose } from "../src/gates.js";
import { getTask } from "../src/store.js";
import fs from "node:fs";
import path from "node:path";
import { commitFiles } from "../src/git.js";

test("conflicts：完全不相交 → 不冲突", () => {
  assert.equal(conflicts(["src/model"], ["src/rating"]), false);
});

test("conflicts：共享 test/ 但各有独占区 → 不冲突（这就是多 Agent 能并行的原因）", () => {
  assert.equal(conflicts(["src/model", "test"], ["src/rating", "test"]), false);
});

test("conflicts：scope 完全相同 → 冲突（同一片地）", () => {
  assert.equal(conflicts(["src/model", "test"], ["src/model", "test"]), true);
});

test("conflicts：一方完全被另一方覆盖 → 冲突", () => {
  assert.equal(conflicts(["src"], ["src/model"]), true);
  assert.equal(conflicts(["src/model"], ["src"]), true);
});

test("conflicts：根 scope 覆盖一切 → 冲突", () => {
  assert.equal(conflicts(["."], ["src/model"]), true);
});

test("三个 Agent 能同时领三条各管一摊的任务", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root, { allowed: ["src", "test"] });
  const a = newTask(db, root, reqId, { title: "模型", scope: ["src/model", "test"] });
  const b = newTask(db, root, reqId, { title: "评级", scope: ["src/rating", "test"] });
  const c = newTask(db, root, reqId, { title: "对账", scope: ["src/recon", "test"] });

  assert.doesNotThrow(() => taskClaim(db, root, { id: a.id }, "agent-1"));
  assert.doesNotThrow(() => taskClaim(db, root, { id: b.id }, "agent-2"));
  assert.doesNotThrow(() => taskClaim(db, root, { id: c.id }, "agent-3"));
});

test("真冲突还是要拦：两个人抢同一片地", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root, { allowed: ["src", "test"] });
  const a = newTask(db, root, reqId, { title: "A", scope: ["src/model", "test"] });
  const b = newTask(db, root, reqId, { title: "B", scope: ["src/model", "test"] });
  taskClaim(db, root, { id: a.id }, "agent-1");
  assert.throws(() => taskClaim(db, root, { id: b.id }, "agent-2"), (e) => e.code === "E_SCOPE_OVERLAP");
});

test("共享目录会告诉 Agent：你和谁共享、共享哪些（别改同一个文件）", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root, { allowed: ["src", "test"] });
  const a = newTask(db, root, reqId, { title: "模型", scope: ["src/model", "test"] });
  const b = newTask(db, root, reqId, { title: "评级", scope: ["src/rating", "test"] });
  taskClaim(db, root, { id: a.id }, "agent-1");

  const claimed = taskClaim(db, root, { id: b.id }, "agent-2");
  assert.equal(claimed.shared.length, 1, "要报出和谁共享");
  assert.equal(claimed.shared[0].task, a.id);
  assert.deepEqual(claimed.shared[0].paths, ["test"]);
});

test("自己已经持有的任务，再领一次要说「已经在你手上」而不是「别人持有」", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  taskClaim(db, root, { id: t.id }, "agent-1");
  assert.throws(
    () => taskClaim(db, root, { id: t.id }, "agent-1"),
    (e) => e.code === "E_ALREADY_HELD" && !/他人|别人/.test(e.message),
  );
});

test("WIP 优先于 scope 冲突：手上有活时先说这个（换 scope 也没用）", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root, { allowed: ["src", "test"] });
  const a = newTask(db, root, reqId, { title: "在办", scope: ["src/model", "test"] });
  const b = newTask(db, root, reqId, { title: "同片地", scope: ["src/model", "test"] });
  taskClaim(db, root, { id: a.id }, "agent-1");
  // 同一 agent 想再领一条同片地的：根本原因是 WIP，不是 scope
  assert.throws(
    () => taskClaim(db, root, { id: b.id }, "agent-1"),
    (e) => e.code === "E_WIP_LIMIT",
    "报 scope 冲突会把人引到错的方向：他换个 scope 再来，照样被 WIP 挡",
  );
});

test("并行干完之后，两个人各自收口互不影响", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root, { allowed: ["src", "test"] });
  const a = newTask(db, root, reqId, { title: "模型", scope: ["src/model", "test"] });
  const b = newTask(db, root, reqId, { title: "评级", scope: ["src/rating", "test"] });
  taskClaim(db, root, { id: a.id }, "agent-1");
  taskClaim(db, root, { id: b.id }, "agent-2");

  fs.mkdirSync(path.join(root, "src/model"), { recursive: true });
  fs.mkdirSync(path.join(root, "src/rating"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/model/m.js"), "export const m = 1;\n");
  fs.writeFileSync(path.join(root, "src/rating/r.js"), "export const r = 2;\n");
  commitFiles(root, ["src/model/m.js"], `feat\n\nTask-Id: ${a.id}`, { author: "agent-1" });
  commitFiles(root, ["src/rating/r.js"], `feat\n\nTask-Id: ${b.id}`, { author: "agent-2" });
  prove(db, root, a.id);
  prove(db, root, b.id);

  await taskClose(db, root, { id: a.id });
  await taskClose(db, root, { id: b.id });
  assert.equal(getTask(db, a.id).status, "done");
  assert.equal(getTask(db, b.id).status, "done");
});