// Path 归属隔离：FR-A 有 approved Path，不代表 FR-B 可以借它开工。
//
// 早先 bootstrap 里的 approvedPath(reqId) 会兜底到「任意 approved Path」，
// 于是 FR-B 还没有自己的 Path 时，next 会拿 FR-A 的 P-00x 去建任务——
// 等于用别人的授权改文件。这类错误在单需求项目里永远看不见。
//
// 这里能稳定断言的是「归属判定」本身：Path 必须挂在需求上才算数。
// 「next 具体返回 wait 还是 claim」还取决于有没有可领的活（另一条队列规则），
// 需要 FR-A 已收口的夹具才能单独验，留到下一步补。
import test from "node:test";
import assert from "node:assert/strict";
import { availableActions } from "../src/digest.js";
import { pathApprove, pathIntake, reqApprove, reqIntake } from "../src/store.js";
import { makeRepo, initFlow } from "./helpers.js";

function twoReqs() {
  const root = makeRepo();
  const { db } = initFlow(root); // FR-001 + P-001(approved，已绑 FR-001)
  const second = reqIntake(db, root, {
    type: "requirement",
    title: "第二个需求",
    goal: "g",
    acceptance: ["npm test :: exit==0"],
  });
  return { root, db, firstReq: "FR-001", secondReq: second.id };
}

test("Path 的归属只认它自己挂的需求：别家的 approved Path 不算这条需求的权限", () => {
  const { root, db, firstReq, secondReq } = twoReqs();
  const draft = pathIntake(db, root, {
    requirementId: secondReq,
    allowedPaths: ["src"],
    budgetLines: 400,
    testCmds: ["npm test"],
  });
  assert.equal(draft.status, "draft", "草案不授予任何权限");
  assert.equal(draft.requiresOwnerApproval, true);
  // FR-B 的草案没有绑定成「已批准」，所以它不能成为开发权限的来源
  const approvedOfSecond = db
    .prepare("SELECT id FROM paths WHERE requirement_id=? AND status='approved'")
    .all(secondReq);
  assert.deepEqual(approvedOfSecond, [], "FR-B 此时不该有任何已批准 Path");
  // FR-A 的 Path 仍然只属于 FR-A：绑定关系没被草案影响
  assert.equal(db.prepare("SELECT requirement_id FROM paths WHERE id='P-001'").get().requirement_id, firstReq);
});

test("FR-B 拿到自己的 approved Path 后，归属与契约都落在 FR-B 上", () => {
  const { root, db, firstReq, secondReq } = twoReqs();
  const draft = pathIntake(db, root, {
    requirementId: secondReq,
    allowedPaths: ["src"],
    budgetLines: 400,
    testCmds: ["npm test"],
  });
  pathApprove(db, root, { pathId: draft.id, channel: "cli" });
  const approved = db.prepare("SELECT requirement_id, status FROM paths WHERE id=?").get(draft.id);
  assert.equal(approved.status, "approved");
  assert.equal(approved.requirement_id, secondReq, "批准后仍属于 FR-B 自己");
  // 两条需求各自的 Path 互不影响
  assert.equal(db.prepare("SELECT status FROM paths WHERE id='P-001'").get().status, "approved");
  assert.equal(db.prepare("SELECT requirement_id FROM paths WHERE id='P-001'").get().requirement_id, firstReq);
  // 有了自己的 Path，动作面才可能出现 task.create
  assert.ok(Array.isArray(availableActions(db)));
});

test("已批准的需求另建 Path 并单独批准：需求状态与验收不动", () => {
  const { root, db, firstReq } = twoReqs();
  const before = db.prepare("SELECT status, acceptance_json FROM requirements WHERE id=?").get(firstReq);
  const draft = pathIntake(db, root, {
    requirementId: firstReq,
    allowedPaths: ["docs"],
    budgetLines: 300,
    testCmds: ["git diff --check"],
  });
  pathApprove(db, root, { pathId: draft.id, channel: "cli" });
  const after = db.prepare("SELECT status, acceptance_json FROM requirements WHERE id=?").get(firstReq);
  assert.equal(after.status, before.status, "Path-only 审批不得改需求状态");
  assert.equal(after.acceptance_json, before.acceptance_json, "也不得改已冻结的验收");
  assert.equal(db.prepare("SELECT status FROM paths WHERE id=?").get(draft.id).status, "approved");
  assert.equal(db.prepare("SELECT status FROM paths WHERE id='P-001'").get().status, "approved", "新增 Path 不是替换");
});

test("需求草稿的首次审批仍需 Owner：Agent 没有等价动作", () => {
  const { root, db, secondReq } = twoReqs();
  const draft = pathIntake(db, root, { requirementId: secondReq, allowedPaths: ["src"], testCmds: ["npm test"] });
  assert.equal(db.prepare("SELECT status FROM requirements WHERE id=?").get(secondReq).status, "draft");
  reqApprove(db, root, { requirementId: secondReq, pathId: draft.id, channel: "cli" });
  assert.equal(db.prepare("SELECT status FROM requirements WHERE id=?").get(secondReq).status, "approved");
  assert.equal(db.prepare("SELECT status FROM paths WHERE id=?").get(draft.id).status, "approved");
});