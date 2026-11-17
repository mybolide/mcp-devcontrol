// devcontrol — Agent 挂了，另一个 Agent 要能接手
//
// 真实事故：Agent A 领了任务后失联（进程挂了 / 被换掉 / 客户端断开），它不会自己释放。
// 于是 B 去领只会得到 E_CLAIMED_BY_OTHER，而控制台的「交接」当时**只生成一张卡片、
// 完全不改 claim 状态**——卡片上还写着「起步: task.claim(T-001)」，B 照做照样被拒。
// 结果就是：这条任务被一个已经不存在的 Agent 占着，直到 45 分钟租约自然过期。
//
// 修法两条：
//   ① Owner 能一键释放（交接 = 释放 + 卡片）
//   ② 被挡住时错误信息要指路：等多久、或者找谁
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeRepo, initFlow, newTask, prove } from "./helpers.js";
import { taskClaim, taskClose } from "../src/gates.js";
import { taskRelease, handoff, getTask } from "../src/store.js";
import { commitFiles } from "../src/git.js";
import { hintFor } from "../src/hints.js";

test("A 领了没做完，B 领不到——但错误里要说清怎么办", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  taskClaim(db, root, { id: t.id }, "agentA");

  await assert.rejects(
    async () => taskClaim(db, root, { id: t.id }, "agentB"),
    (e) => {
      assert.equal(e.code, "E_CLAIMED_BY_OTHER");
      assert.match(e.message, /agentA/, "要说清是谁占着");
      assert.match(e.message, /租约到/, "要给出具体时间，B 才知道等多久");
      return true;
    },
  );
  // hint 要指路：等过期，或者请 Owner 释放
  const hint = hintFor({ code: "E_CLAIMED_BY_OTHER" });
  assert.match(hint, /租约到期/);
  assert.match(hint, /交接/, "要告诉人 Owner 能立刻解开，而不是干等 45 分钟");
});

test("Owner 一释放，B 立刻能领（不用等租约）", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  taskClaim(db, root, { id: t.id }, "agentA");

  const res = taskRelease(db, { taskId: t.id });
  assert.equal(res.releasedFrom, "agentA");
  assert.equal(res.status, "backlog");
  assert.equal(getTask(db, t.id).claimed_by, null);

  const claimed = taskClaim(db, root, { id: t.id }, "agentB");
  assert.equal(claimed.id, t.id);
  assert.equal(getTask(db, t.id).claimed_by, "agentB");
});

test("接手是真的能接着做：A 已经提交的部分照样算交付", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);

  // A 干了一半：改代码 + 提交（带 Task-Id），然后"失联"
  taskClaim(db, root, { id: t.id }, "agentA");
  fs.writeFileSync(path.join(root, "src/a.js"), "export const a = 5;\n");
  commitFiles(root, ["src/a.js"], `feat: 一半\n\nTask-Id: ${t.id}`, { author: "agentA" });

  // Owner 交给 B
  taskRelease(db, { taskId: t.id });
  taskClaim(db, root, { id: t.id }, "agentB");

  // B 接着补完并收口：归属跟的是任务，不是人
  fs.writeFileSync(path.join(root, "src/b.js"), "export const b = 6;\n");
  commitFiles(root, ["src/b.js"], `feat: 另一半\n\nTask-Id: ${t.id}`, { author: "agentB" });
  prove(db, root, t.id);

  const res = await taskClose(db, root, { id: t.id });
  assert.equal(res.commits.length, 2, "两个人的提交都该算这条任务的");
  assert.equal(getTask(db, t.id).status, "done");
});

test("交接 = 释放 + 卡片（卡片上那句 claim 才不是空话）", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  taskClaim(db, root, { id: t.id }, "agentA");

  const res = handoff(db, { taskId: t.id });
  assert.ok(res.released, "在办的任务被交接时必须真的释放");
  assert.equal(res.released.releasedFrom, "agentA");
  assert.match(res.text, /已释放/);
  assert.equal(getTask(db, t.id).status, "backlog", "交接之后它回到待办");
});

test("交接一个本来就在待办的任务：只出卡片，不动状态", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  const res = handoff(db, { taskId: t.id });
  assert.equal(res.released, null);
  assert.match(res.text, /task\.claim/);
});

test("没人在办的任务不需要释放（明确拒绝，而不是静默成功）", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  assert.throws(() => taskRelease(db, { taskId: t.id }), (e) => e.code === "E_ILLEGAL_TRANSITION");
});

test("释放不存在的任务报 NOT_FOUND", () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  assert.throws(() => taskRelease(db, { taskId: "T-999" }), (e) => e.code === "NOT_FOUND");
});

test("释放不算返工：review_round 不变（这不是它的错）", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  taskClaim(db, root, { id: t.id }, "agentA");
  taskRelease(db, { taskId: t.id });
  assert.equal(getTask(db, t.id).review_round, 0);
});