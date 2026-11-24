// devcontrol — Owner 问题要带「五要素」（P0-3）
//
// 「遇到什么 / 试过什么 / 为什么不能自己办 / 推荐方案 / 需要你定的唯一一件事」。
// 前两条内核自己就能补（失败历史），后三条只有 Agent 知道。
// 不硬拦（拦了会逼人编一句话糊弄），但缺什么必须留痕——否则
// 「Agent 把研发判断转嫁给用户」这件事永远没人统计得出来。
import test from "node:test";
import assert from "node:assert/strict";
import { ask, taskClaim } from "../src/gates.js";
import { logEvent } from "../src/db.js";
import { makeRepo, initFlow, newTask } from "./helpers.js";

function doing() {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const task = newTask(db, root, reqId);
  taskClaim(db, root, { id: task.id }, "agentA");
  return { root, db, task };
}

test("五要素齐全时，问题被写成结构化的五段", () => {
  const { db, task } = doing();
  const res = ask(db, {
    taskId: task.id,
    kind: "owner",
    question: "要不要删旧接口？",
    detail: {
      problem: "旧接口和新契约冲突",
      tried: "试过保留别名、试过双写",
      whyNot: "两套语义并存会长期腐蚀契约",
      recommendation: "直接删，并在 CHANGELOG 写迁移说明",
      decision: "这次要不要做破坏性变更",
    },
  });
  assert.deepEqual(res.missing, []);
  const row = db.prepare("SELECT question FROM questions WHERE id=?").get(res.questionId);
  for (const label of ["遇到什么问题", "已经试过什么", "为什么不能自己办", "我推荐的方案", "需要你定的唯一一件事"]) {
    assert.match(row.question, new RegExp(label), `缺少「${label}」这一段`);
  }
  db.close();
});

test("缺要素时如实留痕：问题是原文，另记一条 ask.quality", () => {
  const { db, task } = doing();
  logEvent(db, { actor: "agent", action: "close.fail", taskId: task.id, code: "E_ASSERTION_FAILED", detail: "没过" });
  const res = ask(db, { taskId: task.id, kind: "owner", question: "这两个方案选哪个？" });
  assert.ok(res.missing.includes("whyNot"));
  assert.ok(res.missing.includes("recommendation"));
  assert.ok(res.missing.includes("decision"));
  assert.equal(res.elements.tried, "E_ASSERTION_FAILED", "试过什么由内核从失败历史补");
  const row = db.prepare("SELECT question FROM questions WHERE id=?").get(res.questionId);
  assert.equal(row.question, "这两个方案选哪个？", "缺要素时不要伪造结构，原文照存");
  const q = db.prepare("SELECT detail FROM events WHERE action='ask.quality' AND task_id=?").get(task.id);
  assert.ok(q, "必须留下 ask.quality 记录");
  assert.match(q.detail, /recommendation/);
  db.close();
});