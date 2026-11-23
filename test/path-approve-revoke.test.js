import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { getPath, getReq, pathApprove, pathIntake, pathRevoke, taskAbandon } from "../src/store.js";
import { taskClaim } from "../src/gates.js";
import { makeRepo, initFlow, newTask, BIN } from "./helpers.js";

const REASON = "这条 Path 的范围建错了，重建一条"; // 废弃理由有 12 字下限

function fixture() {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  return { root, db, reqId };
}

const draftPath = (db, root, reqId) =>
  pathIntake(db, root, {
    requirementId: reqId,
    allowedPaths: ["src"],
    allowNewFiles: false,
    budgetLines: 400,
    testCmds: ["npm test"],
  });

test("path.approve 只冻 Path：契约落盘、预算与验收生效，需求状态不动", () => {
  const { root, db, reqId } = fixture();
  const draft = draftPath(db, root, reqId);
  const approved = pathApprove(db, root, { pathId: draft.id, channel: "cli" });
  assert.equal(approved.status, "approved");
  assert.equal(approved.budgetLines, 400);
  assert.match(approved.testCmds.join(" "), /npm test/);
  assert.match(approved.contractCommit ?? "", /^[0-9a-f]{7,40}$/);
  const path = getPath(db, draft.id);
  assert.equal(path.status, "approved");
  // 草案是为哪条需求建的，批准后要能对上——否则不知道冻了谁的验收
  assert.equal(path.requirement_id, reqId);
  assert.ok(path.approved_at);
  // 这条动作的边界就是只冻 Path：需求状态不能被顺手改掉
  assert.equal(getReq(db, reqId).status, "approved");
  // 重复批准必须拒绝：批准等于授予写权限，不能悄悄换掉已冻结的契约
  assert.throws(() => pathApprove(db, root, { pathId: draft.id }), (e) => e.code === "E_ILLEGAL_TRANSITION");
});

test("path.revoke 只废弃这条 Path：需求与其它 Path 都不动", () => {
  const { root, db, reqId } = fixture();
  const doomed = draftPath(db, root, reqId);
  assert.equal(pathRevoke(db, root, { pathId: doomed.id, reason: REASON, channel: "cli" }).pathId, doomed.id);
  assert.equal(getPath(db, doomed.id).status, "revoked");
  assert.equal(getReq(db, reqId).status, "approved");
  assert.equal(getPath(db, "P-001").status, "approved");
  // 废弃过的既不能再批准，也不能重复废弃
  assert.throws(() => pathRevoke(db, root, { pathId: doomed.id, reason: REASON }), (e) => e.code === "E_ILLEGAL_TRANSITION");
  assert.throws(() => pathApprove(db, root, { pathId: doomed.id }), (e) => e.code === "E_ILLEGAL_TRANSITION");
});

test("还有在办任务时不许废弃 Path：那批任务会莫名收不了口", () => {
  const { root, db, reqId } = fixture();
  const draft = draftPath(db, root, reqId);
  pathApprove(db, root, { pathId: draft.id });
  const task = newTask(db, root, reqId, { pathId: draft.id });
  taskClaim(db, root, { id: task.id }, "agent-a");
  assert.throws(() => pathRevoke(db, root, { pathId: draft.id, reason: REASON }), (e) => e.code === "E_PATH_IN_USE");
  // 任务作废之后就能废弃：不是永远锁死，只是要求按顺序来
  taskAbandon(db, root, { taskId: task.id, reason: "这条 Path 建错了，重建一条", channel: "owner" });
  assert.equal(pathRevoke(db, root, { pathId: draft.id, reason: REASON }).pathId, draft.id);
});

test("CLI：path approve 与 path revoke 打得出契约，也认得出错误用法", () => {
  const { root, db, reqId } = fixture();
  const draft = draftPath(db, root, reqId);
  const cli = (...args) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [BIN, ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
    } catch (error) {
      return { code: error.status ?? 1, out: String(error.stdout ?? "") + String(error.stderr ?? "") };
    }
  };
  const approved = cli("path", "approve", draft.id);
  assert.equal(approved.code, 0, approved.out);
  assert.match(approved.out, /已批准（契约已冻结）/);
  assert.match(approved.out, /需求：FR-001（状态不变，只冻 Path）/);

  const noReason = cli("path", "revoke", draft.id);
  assert.notEqual(noReason.code, 0, "没有理由不该废弃");
  assert.match(noReason.out, /--reason/);

  const revoked = cli("path", "revoke", draft.id, "--reason", REASON);
  assert.equal(revoked.code, 0, revoked.out);
  assert.match(revoked.out, /已废弃（需求不受影响）/);
});