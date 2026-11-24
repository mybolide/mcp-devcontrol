// devcontrol — close 的提交区间不该把历史提交算成本任务的责任（B-002）
//
// 现场（Agent Studio T-042）：close 报 E_UNOWNED_COMMIT，被点名的提交全都早于本任务开始，
// 分别是上一条已被放弃的任务（T-040 abandoned）和更早已完成的任务（T-039 done）留下的。
//
// 真正的根因不在 isAncestor 的方向，而是 owner 时间窗：
//   const to = secFloor(o.closed_at ?? o.claim_expires_at ?? Date.now()) + 999;
// 被放弃的任务既没有 closed_at 也没有 claim_expires_at，于是把**数字** Date.now()
// 传给了只接受 ISO 字符串的 secFloor（Date.parse(数字) → NaN → 0），
// 窗口塌成 1970，该任务的所有提交都「晚于窗口」→ validOwner 恒 false → 判无主。
//
// 另一条约束必须同时守住：区间里真有没人认领的提交时，仍然要拦。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeRepo, initFlow, newTask, closeProven } from "./helpers.js";
import { taskClaim } from "../src/gates.js";
import { getTask, taskAbandon } from "../src/store.js";
import { commitFiles, head } from "../src/git.js";

const write = (root, file, body) => fs.writeFileSync(path.join(root, file), body);
const commitAs = (root, file, taskId, author = "agent") =>
  commitFiles(root, [file], `feat: ${taskId}\n\nTask-Id: ${taskId}`, { author });

/** 把任务的 base_head 往回拨：真实现场里它取的是 Path 契约提交，比邻居任务的提交还早。 */
const staleBase = (db, taskId, base) => db.prepare("UPDATE tasks SET base_head=? WHERE id=?").run(base, taskId);
const ABANDON_A = "这条路不走了，改用 Host 侧方案";
const ABANDON_B = "不做了，需求改到别的任务下";

test("B-002：被放弃的任务提交不能把下一条任务的收口堵死", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);

  const a = newTask(db, root, reqId, { title: "先做 A" });
  const beforeA = head(root);
  taskClaim(db, root, { id: a.id }, "agent");
  write(root, "src/a.js", "export const a = 2;\n");
  commitAs(root, "src/a.js", a.id);
  taskAbandon(db, root, { taskId: a.id, reason: ABANDON_A });

  const b = newTask(db, root, reqId, { title: "接着做 B" });
  staleBase(db, b.id, beforeA); // 区间里会带上 A 的提交
  taskClaim(db, root, { id: b.id }, "agent");
  write(root, "src/a.js", "export const a = 3;\n");
  commitAs(root, "src/a.js", b.id);

  const res = await closeProven(db, root, { id: b.id });
  assert.equal(getTask(db, b.id).status, "done");
  assert.equal(res.commits.length, 1, `只该算本任务那一条提交：${JSON.stringify(res.commits)}`);
});

test("已完成任务的提交（close 时登记过）同样不算无主", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);

  const a = newTask(db, root, reqId, { title: "先做 A" });
  const beforeA = head(root);
  taskClaim(db, root, { id: a.id }, "agent");
  write(root, "src/a.js", "export const a = 4;\n");
  commitAs(root, "src/a.js", a.id);
  await closeProven(db, root, { id: a.id });

  const b = newTask(db, root, reqId, { title: "接着做 B" });
  staleBase(db, b.id, beforeA);
  taskClaim(db, root, { id: b.id }, "agent");
  write(root, "src/a.js", "export const a = 5;\n");
  commitAs(root, "src/a.js", b.id);

  const res = await closeProven(db, root, { id: b.id });
  assert.equal(getTask(db, b.id).status, "done");
  assert.equal(res.commits.length, 1);
});

test("区间里真有没人认领的提交，仍然要拦（修 bug 不能放宽门禁）", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);

  const a = newTask(db, root, reqId, { title: "做 A" });
  const beforeA = head(root);
  taskClaim(db, root, { id: a.id }, "agent");

  // 一条没有 Task-Id 的提交：谁都不认，必须被点名
  write(root, "src/loose.js", "export const loose = 1;\n");
  commitFiles(root, ["src/loose.js"], "chore: 手写的改动，忘了 Task-Id", { author: "agent" });

  write(root, "src/a.js", "export const a = 6;\n");
  commitAs(root, "src/a.js", a.id);
  staleBase(db, a.id, beforeA); // 让它落在区间里

  await assert.rejects(
    () => closeProven(db, root, { id: a.id }),
    (e) => e.code === "E_UNOWNED_COMMIT",
    "无主提交必须继续被拦",
  );
});

test("多提交任务：两条提交都算自己的", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);

  const a = newTask(db, root, reqId, { title: "两步做完" });
  taskClaim(db, root, { id: a.id }, "agent");
  write(root, "src/a.js", "export const a = 7;\n");
  commitAs(root, "src/a.js", a.id);
  write(root, "src/a.js", "export const a = 8;\n");
  commitAs(root, "src/a.js", a.id);

  const res = await closeProven(db, root, { id: a.id });
  assert.equal(res.commits.length, 2, `两条提交都要算进来：${JSON.stringify(res.commits)}`);
});

test("放弃任务后它既没有 closed_at 也没有 claim_expires_at（B-002 的触发前提）", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const a = newTask(db, root, reqId, { title: "A 做了又放弃" });
  taskClaim(db, root, { id: a.id }, "agent");
  write(root, "src/a.js", "export const a = 9;\n");
  commitAs(root, "src/a.js", a.id);
  taskAbandon(db, root, { taskId: a.id, reason: ABANDON_B });

  const row = db.prepare("SELECT status, closed_at, claim_expires_at FROM tasks WHERE id=?").get(a.id);
  assert.equal(row.status, "abandoned");
  // 这两列都是 null，所以 owner 时间窗只能退到「现在」——secFloor 必须能接住数字
  assert.equal(row.closed_at, null);
  assert.equal(row.claim_expires_at, null);
});


test("base_head 被推到任务提交之后时，仍要能找回自己的提交（祖先判断方向不能反）", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);

  const a = newTask(db, root, reqId, { title: "做完自己的活" });
  taskClaim(db, root, { id: a.id }, "agent");
  write(root, "src/a.js", "export const a = 10;\n");
  commitAs(root, "src/a.js", a.id);
  // 同一任务再来一条提交；随后 base_head 被带到这条更晚的提交上
  // （真实现场：Owner 调预算 / 重批 Path 会在任务提交之后写契约提交）。
  write(root, "src/a.js", "export const a = 11;\n");
  const later = commitAs(root, "src/a.js", a.id);
  staleBase(db, a.id, later);

  const res = await closeProven(db, root, { id: a.id });
  assert.equal(getTask(db, a.id).status, "done");
  // 靠「本任务最早那条提交的父提交」把起点往前挪一格才找得到；
  // 若把 isAncestor(parent, base_head) 写反成 isAncestor(base_head, parent)，
  // 这里就会退化成 E_NO_DELIVERY（提交凭空消失）。
  assert.equal(res.commits.length, 2, `要把任务自己的两条提交都找回来：${JSON.stringify(res.commits)}`);
});

test("新建任务的 base_head 取的是当时的 HEAD，不是更早的 Path 契约提交", () => {
  // 区间起点比任务实际开始还早，就会把邻居任务的历史提交扫进来——
  // owner 判定一旦有出入，收口就报「无主提交」（B-002 的第二个成因）。
  const root = makeRepo();
  const { db, reqId } = initFlow(root);

  const a = newTask(db, root, reqId, { title: "先做 A" });
  taskClaim(db, root, { id: a.id }, "agent");
  write(root, "src/a.js", "export const a = 20;\n");
  const aSha = commitAs(root, "src/a.js", a.id);

  const b = newTask(db, root, reqId, { title: "之后才建 B" });
  assert.equal(b.base_head, aSha, "B 的起点必须是它被创建时的 HEAD（A 的提交）");
  assert.notEqual(b.base_head, b.contract_commit, "不该退回 Path 契约提交");
});