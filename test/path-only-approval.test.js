// 已批准需求的「只批 Path」：需求不重审，新 Path 仍要真人确认。
import test from "node:test";
import assert from "node:assert/strict";
import { getApprovalPreview, requestOwnerApproval } from "../src/chat-owner-approval-mcp.js";
import { pathAdjust, pathIntake, reqAmend } from "../src/store.js";
import { makeRepo, initFlow } from "./helpers.js";

function fixture() {
  const root = makeRepo();
  const { db, reqId } = initFlow(root); // FR-001 已 approved，P-001 已 approved
  const draft = pathIntake(db, root, {
    requirementId: reqId,
    allowedPaths: ["docs"],
    budgetLines: 300,
    testCmds: ["git diff --check"],
  });
  return { root, db, reqId, draft };
}

const accept = () => async () => ({ action: "accept", content: { decision: "批准" } });
const decline = () => async () => ({ action: "accept", content: { decision: "拒绝" } });

const reqRow = (db, id) => db.prepare("SELECT status, acceptance_json FROM requirements WHERE id=?").get(id);
const pathRow = (db, id) => db.prepare("SELECT status, budget_lines FROM paths WHERE id=?").get(id);

test("已批准需求的新 Path：预览判定为 path-only，且不要求重审需求", () => {
  const { db, reqId, draft } = fixture();
  const preview = getApprovalPreview(db, reqId, draft.id);
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.equal(preview.mode, "path-only");
  assert.equal(preview.pathId, draft.id);
  assert.equal(reqRow(db, reqId).status, "approved", "预览不得改需求状态");
});

test("真人批准后只冻这条 Path：需求状态与验收一字不动", async () => {
  const { root, db, reqId, draft } = fixture();
  const before = reqRow(db, reqId);
  const res = await requestOwnerApproval({
    db, root, requirementId: reqId, pathId: draft.id,
    clientSupportsElicitation: true, elicit: accept(),
  });
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.ok, true, JSON.stringify(payload));
  assert.equal(payload.kind, "path-approved");
  assert.equal(pathRow(db, draft.id).status, "approved");
  assert.deepEqual(reqRow(db, reqId), before, "需求状态与验收不得被改动");
  // 原来那条 Path 仍然有效
  assert.equal(db.prepare("SELECT status FROM paths WHERE id='P-001'").get().status, "approved");
});

test("用户拒绝 = 什么都不改", async () => {
  const { root, db, reqId, draft } = fixture();
  const res = await requestOwnerApproval({
    db, root, requirementId: reqId, pathId: draft.id,
    clientSupportsElicitation: true, elicit: decline(),
  });
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, "E_OWNER_DECLINED");
  assert.equal(pathRow(db, draft.id).status, "draft");
});

test("客户端不支持 elicitation：拿不到真人确认就不动库", async () => {
  const { root, db, reqId, draft } = fixture();
  const res = await requestOwnerApproval({
    db, root, requirementId: reqId, pathId: draft.id,
    clientSupportsElicitation: false, elicit: accept(),
  });
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, "E_OWNER_CONFIRMATION_UNAVAILABLE");
  assert.equal(pathRow(db, draft.id).status, "draft");
});

test("确认期间 Path 内容变了：旧确认失效（TOCTOU）", async () => {
  const { root, db, reqId, draft } = fixture();
  let snapshot = null;
  const res = await requestOwnerApproval({
    db, root, requirementId: reqId, pathId: draft.id,
    clientSupportsElicitation: true,
    elicit: async () => {
      // 真人看到的还是旧预算，这里模拟「看的同时有人改了 Path」
      pathAdjust(db, root, { pathId: draft.id, budgetLines: 900, reason: "Owner 在确认期间改了预算" });
      snapshot = true;
      return { action: "accept", content: { decision: "批准" } };
    },
  });
  const payload = JSON.parse(res.content[0].text);
  assert.equal(snapshot, true);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, "E_APPROVAL_STALE");
  assert.equal(pathRow(db, draft.id).status, "draft", "内容变了就不能沿用旧确认");
});
test("需求内容在确认期间变了：旧确认失效（需求侧 TOCTOU）", async () => {
  const { root, db, reqId, draft } = fixture();
  const res = await requestOwnerApproval({
    db, root, requirementId: reqId, pathId: draft.id,
    clientSupportsElicitation: true,
    elicit: async () => {
      // 模拟「真人看确认框的同时，另一边改了这条需求」：摘要必须因此作废。
      db.prepare("UPDATE requirements SET title=? WHERE id=?").run("确认期间被改写", reqId);
      return { action: "accept", content: { decision: "批准" } };
    },
  });
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.ok, false, JSON.stringify(payload));
  assert.equal(payload.code, "E_APPROVAL_STALE");
  assert.equal(pathRow(db, draft.id).status, "draft", "需求变了就不能沿用旧确认");
});
