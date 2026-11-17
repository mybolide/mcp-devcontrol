// devcontrol — 活干完了，就别再催着「去拆新任务」
//
// 之前的兜底永远返回 task.create +「没有待办任务，去拆新任务」。
// 对一个已经做完的项目，这句话是错的：Agent 会凭空造出一条没人要的工作，
// 然后按门禁老老实实做完、收口——制造噪音，还占预算。
//
// 正确的说法取决于有没有发布计划：
//   · 有发布且任务齐了 → 「可以发布了」
//   · 有发布但还差任务   → 「还差 N 个」
//   · 没发布             → 「需求都覆盖了，可以发布或等新需求」
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeRepo, initFlow, newTask, prove } from "./helpers.js";
import { commitFiles } from "../src/git.js";
import { bootstrap } from "../src/digest.js";
import { taskClaim, taskClose } from "../src/gates.js";
import { createRelease, planRelease } from "../src/release.js";

/** 把一条任务做完收口（这样需求的验收就全被覆盖了） */
async function finishTask(db, root, task) {
  taskClaim(db, root, { id: task.id }, "agent");
  fs.writeFileSync(path.join(root, "src/a.js"), `export const a = ${task.id.length + 7};\n`);
  commitFiles(root, ["src/a.js"], `feat\n\nTask-Id: ${task.id}`, { author: "agent" });
  prove(db, root, task.id);
  await taskClose(db, root, { id: task.id });
}

test("需求都覆盖、没有发布计划：说「可以发布或等新需求」，不再催拆任务", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  await finishTask(db, root, newTask(db, root, reqId));

  const digest = bootstrap(db, root);
  assert.equal(digest.next.action, "wait", `不该再让人建任务：${JSON.stringify(digest.next)}`);
  assert.match(digest.next.why, /需求都覆盖了/);
  assert.doesNotMatch(digest.next.why, /拆新任务/);
});

test("有发布且任务齐了：直接说可以发布，并给命令", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  const rel = createRelease(db, { title: "v1.0" });
  planRelease(db, { id: rel.id, tasks: [t.id] });
  await finishTask(db, root, t);

  const digest = bootstrap(db, root);
  assert.equal(digest.next.action, "wait");
  assert.match(digest.next.why, /可以发布/);
  assert.match(digest.next.why, new RegExp(rel.id), "要给出发布号，人能直接照抄");
});

test("有发布但还差任务：说还差几个，而不是让人去拆新任务", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  const rel = createRelease(db, { title: "v1.1" });
  planRelease(db, { id: rel.id, tasks: [t.id] });
  // 任务被放弃（不做），所以既没有可领的活、发布又凑不齐
  db.prepare("UPDATE tasks SET status='abandoned' WHERE id=?").run(t.id);

  const digest = bootstrap(db, root);
  assert.match(digest.next.why, /还有 1 个任务没完成/);
  assert.match(digest.next.why, /控制台/);
});

test("还有活可干时，绝不返回「活干完了」的说法", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  newTask(db, root, reqId); // 有待办任务
  const digest = bootstrap(db, root);
  assert.equal(digest.next.action, "task.claim");
  assert.doesNotMatch(digest.next.why, /都覆盖了/);
});

test("actions 跟着收窄：有活可干时不给 task.create", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  newTask(db, root, reqId);
  const digest = bootstrap(db, root);
  assert.ok(digest.actions.includes("task.claim"));
  assert.ok(!digest.actions.includes("task.create"), `有活可干时给的是一组矛盾动作：${JSON.stringify(digest.actions)}`);
});

test("没活可干时才给 task.create（提了新需求要能拆）", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  // 需求有一条验收，但没有任何任务覆盖它 → 这就是"要拆任务"的场景
  void reqId;
  const digest = bootstrap(db, root);
  assert.ok(digest.actions.includes("task.create"), JSON.stringify(digest.actions));
  assert.ok(!digest.actions.includes("task.claim"), "没活可领就不该给 claim");
});