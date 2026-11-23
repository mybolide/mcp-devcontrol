// devcontrol — 交付模式（code / verify）的门禁测试
//
// 背景（T-011）：Clippy / 编译检查 / 只跑测试这类任务本来就不该产生代码改动，
// 但内核要求「收口必须有本任务的提交」，于是这类任务永远收不了口，只能挂着等 Owner。
// 修法不是放宽 E_NO_DELIVERY，而是让任务在创建时就说清楚自己是哪种交付：
//   code（默认）= 交出归属提交   verify = 只交出「跑通验收」的证据
// 并且 verify 必须反向卡死：不许偷偷交提交、证据必须绑当前 HEAD、工作树必须干净。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getTask, taskAdjust } from "../src/store.js";
import { taskClaim, taskClose, taskCreate } from "../src/gates.js";
import { listCompletions } from "../src/completion.js";
import { commitFiles } from "../src/git.js";
import { bootstrap } from "../src/digest.js";
import { makeRepo, initFlow, newTask, prove, closeProven, CLOSE_NOTE } from "./helpers.js";

const verifyTask = (db, root, reqId, extra = {}) => newTask(db, root, reqId, { delivery: "verify", ...extra });

test("默认交付模式是 code，老习惯不受影响：没有提交就收不了口", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const task = newTask(db, root, reqId);
  assert.equal(task.delivery, "code");
  taskClaim(db, root, { id: task.id }, "agentA");
  await assert.rejects(() => closeProven(db, root, { id: task.id }), (e) => e.code === "E_NO_DELIVERY");
});

test("verify 任务：只要跑通契约验收就能收口，且不要求任何提交", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const task = verifyTask(db, root, reqId);
  taskClaim(db, root, { id: task.id }, "agentA");
  const res = await closeProven(db, root, { id: task.id });
  assert.equal(res.delivery, "verify");
  assert.deepEqual(res.commits, []);
  assert.equal(res.files, 0);
  assert.equal(res.lines, 0);
  assert.equal(getTask(db, task.id).status, "done");
  // 交付记录里必须留痕：否则 review 的人只看到「一条没有提交的 done」会以为是漏了
  assert.equal(listCompletions(db, task.id)[0].delivery, "verify");
});

test("verify 任务是反向卡死的：偷偷提交就收不了口（E_VERIFY_COMMITTED）", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const task = verifyTask(db, root, reqId);
  taskClaim(db, root, { id: task.id }, "agentA");
  fs.writeFileSync(path.join(root, "src/a.js"), "export const a = 2;\n");
  commitFiles(root, ["src/a.js"], `feat\n\nTask-Id: ${task.id}`, { author: "agentA" });
  await assert.rejects(() => closeProven(db, root, { id: task.id }), (e) => e.code === "E_VERIFY_COMMITTED");
  assert.equal(getTask(db, task.id).status, "doing");
});

test("verify 任务不许偷偷改产品文件：工作树脏就收不了口（E_DIRTY_SCOPE）", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const task = verifyTask(db, root, reqId);
  taskClaim(db, root, { id: task.id }, "agentA");
  fs.writeFileSync(path.join(root, "src/a.js"), "export const a = 3;\n"); // 改了但不提交
  await assert.rejects(() => closeProven(db, root, { id: task.id }), (e) => e.code === "E_DIRTY_SCOPE");
});

test("verify 任务没有证据也不行：不提交不等于免验收（E_NO_EVIDENCE）", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const task = verifyTask(db, root, reqId);
  taskClaim(db, root, { id: task.id }, "agentA");
  await assert.rejects(() => taskClose(db, root, { id: task.id, summary: "s", changes: "c", limitations: "无" }), (e) => e.code === "E_NO_EVIDENCE");
});

test("verify 任务的证据绑定 HEAD：代码换过就得重跑（E_EVIDENCE_STALE_HEAD），且不算 Agent 返工", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const task = verifyTask(db, root, reqId);
  taskClaim(db, root, { id: task.id }, "agentA");
  prove(db, root, task.id); // 先跑出证据（此时指纹与 HEAD 都对）
  // 在 scope 外新增一个文件：指纹（只覆盖 scope）不会变，但代码版本变了
  fs.writeFileSync(path.join(root, "README.md"), "# 项目\n");
  commitFiles(root, ["README.md"], "docs: readme", { author: "agentA" });
  // 手写 close（不走 closeProven）：它会在 close 前重跑一遍证据，把「证据旧了」这件事盖掉，
  // 而这条测的正是「拿旧证据收口」本身。
  await assert.rejects(() => taskClose(db, root, { id: task.id, ...CLOSE_NOTE }), (e) => e.code === "E_EVIDENCE_STALE_HEAD");
  const t = getTask(db, task.id);
  assert.equal(t.status, "doing");
  assert.equal(t.review_round, 0, "「重跑一遍」不是返工，不该记在 Agent 头上");
});

test("verify 任务重跑一次就能过：HEAD 与证据对齐后正常收口", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const task = verifyTask(db, root, reqId);
  taskClaim(db, root, { id: task.id }, "agentA");
  prove(db, root, task.id);
  fs.writeFileSync(path.join(root, "README.md"), "# 项目\n");
  commitFiles(root, ["README.md"], "docs: readme", { author: "agentA" });
  await assert.rejects(() => taskClose(db, root, { id: task.id, ...CLOSE_NOTE }), (e) => e.code === "E_EVIDENCE_STALE_HEAD");
  prove(db, root, task.id); // 在新 HEAD 上重跑
  const res = await closeProven(db, root, { id: task.id });
  assert.equal(res.delivery, "verify");
  assert.equal(getTask(db, task.id).status, "done");
});

test("未知交付模式直接报错，不静默改成 code", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  assert.throws(
    () => taskCreate(db, root, { requirementId: reqId, pathId: "P-001", title: "x", delivery: "noop", acceptance: [{ deriveFrom: 0, assertion: "npm test :: exit==0" }], scope: ["src"] }),
    (e) => e.code === "INVALID_ARGUMENT",
  );
});

test("evidence-only 是 verify 的别名（人能猜到的写法都认）", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const task = newTask(db, root, reqId, { delivery: "evidence-only" });
  assert.equal(task.delivery, "verify");
});

test("next 不会催 verify 任务去 commit：先跑验收，跑通了直接收口", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const task = verifyTask(db, root, reqId);
  taskClaim(db, root, { id: task.id }, "agentA");
  const before = bootstrap(db, root).next;
  assert.equal(before.action, "task.work");
  assert.match(before.why, /verify/);
  assert.match(before.why, /不要 commit/);
  prove(db, root, task.id);
  const after = bootstrap(db, root).next;
  assert.equal(after.action, "task.close");
  assert.match(after.why, /verify/);
});

test("Owner 可以改交付模式（补救派错的任务），已收口的任务不行", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const task = newTask(db, root, reqId);
  const res = taskAdjust(db, root, { taskId: task.id, delivery: "verify", reason: "这条是 Clippy 验收，本来就不该有代码改动" });
  assert.equal(res.delivery, "verify");
  assert.equal(getTask(db, task.id).delivery, "verify");
  // 必须留审计：Audit 里要能看出是谁、为什么把交付口径改了
  const event = db.prepare("SELECT * FROM events WHERE task_id=? AND action='task.adjust' ORDER BY id DESC LIMIT 1").get(task.id);
  assert.ok(event, "改交付模式必须留 task.adjust 事件");
  assert.match(String(event.detail), /交付 code → verify/);

  taskClaim(db, root, { id: task.id }, "agentA");
  await closeProven(db, root, { id: task.id });
  assert.throws(
    () => taskAdjust(db, root, { taskId: task.id, delivery: "code", reason: "事后反悔" }),
    (e) => e.code === "E_ILLEGAL_TRANSITION",
  );
});

test("非法交付模式不许调：只能 code 或 verify", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const task = newTask(db, root, reqId);
  assert.throws(
    () => taskAdjust(db, root, { taskId: task.id, delivery: "skip", reason: "想绕过门禁" }),
    (e) => e.code === "INVALID_ARGUMENT",
  );
});