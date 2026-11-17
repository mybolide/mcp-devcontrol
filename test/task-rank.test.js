// devcontrol — Backlog 的顺序就是优先级
//
// Jira 的 backlog 核心就一件事：顺序即优先级。不需要 priority 标签体系，
// 只要 Owner 能把某条往上提，内核挑活时先看它。
//
// 之前 next 完全按「依赖满足 + ID 小」排，Owner 建完任务只能排到队尾，插不进去。
import test from "node:test";
import assert from "node:assert/strict";
import { makeRepo, initFlow, newTask } from "./helpers.js";
import { bootstrap, claimableTasks } from "../src/digest.js";
import { listTasks, taskRank } from "../src/store.js";

const setup = (root) => {
  const { db, reqId } = initFlow(root);
  const a = newTask(db, root, reqId, { title: "先建的" });
  const b = newTask(db, root, reqId, { title: "后建的" });
  return { db, reqId, a, b };
};

test("默认按建的顺序挑（ID 小的先）", () => {
  const root = makeRepo();
  const { db, a } = setup(root);
  const { ok } = claimableTasks(db, listTasks(db));
  assert.equal(ok[0].id, a.id);
});

test("置顶之后，内核先挑它（next 也跟着变）", () => {
  const root = makeRepo();
  const { db, b } = setup(root);
  taskRank(db, { taskId: b.id, mode: "top" });

  const { ok } = claimableTasks(db, listTasks(db));
  assert.equal(ok[0].id, b.id, "置顶的任务要排到最前");

  const digest = bootstrap(db, root);
  assert.equal(digest.next.action, "task.claim");
  assert.equal(digest.next.args.id, b.id, "next 说的下一件事必须是它");
});

test("连续置顶：后置顶的排更前（rank 递减，不会打平）", () => {
  const root = makeRepo();
  const { db, reqId, a, b } = setup(root);
  const c = newTask(db, root, reqId, { title: "第三条" });

  taskRank(db, { taskId: b.id, mode: "top" }); // b 置顶
  taskRank(db, { taskId: c.id, mode: "top" }); // c 再置顶 → c 更靠前

  const { ok } = claimableTasks(db, listTasks(db));
  assert.deepEqual(ok.map((t) => t.id), [c.id, b.id, a.id]);
});

test("还没开工的任务才谈得上排序：已经在办的不许动顺序", async () => {
  const root = makeRepo();
  const { db, a } = setup(root);
  const { taskClaim } = await import("../src/gates.js");
  taskClaim(db, root, { id: a.id }, "agent");
  assert.throws(
    () => taskRank(db, { taskId: a.id, mode: "top" }),
    (e) => e.code === "E_ILLEGAL_TRANSITION",
    "在办的任务插队没有意义，改顺序应该在建任务或 parked 时做",
  );
});

test("parked 的任务也能排序（等 Owner 决定之后还要回到队列）", () => {
  const root = makeRepo();
  const { db, reqId, a } = setup(root);
  db.prepare("UPDATE tasks SET status='parked' WHERE id=?").run(a.id);
  const res = taskRank(db, { taskId: a.id, mode: "top" });
  assert.equal(typeof res.rank, "number");
});

test("给数字就直接用（高级用法：排到某条之后）", () => {
  const root = makeRepo();
  const { db, a } = setup(root);
  const res = taskRank(db, { taskId: a.id, rank: 42 });
  assert.equal(res.rank, 42);
});

test("乱传参数要拒，不能静默不改", () => {
  const root = makeRepo();
  const { db, a } = setup(root);
  assert.throws(() => taskRank(db, { taskId: a.id }), (e) => e.code === "E_CONTRACT");
});

test("不存在的任务报 NOT_FOUND", () => {
  const root = makeRepo();
  const { db } = setup(root);
  assert.throws(() => taskRank(db, { taskId: "T-999", mode: "top" }), (e) => e.code === "NOT_FOUND");
});
