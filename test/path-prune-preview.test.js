// devcontrol — Path 契约体检（只读）：哪些冻结命令碰的路径不在授权范围里
//
// 为什么这件事必须只读：摘掉一条已批准契约里的命令，等于改一份 Owner 签过字的东西。
// 内核能算出「这条命令名不副实」，但**不能自己动手**——那样授权就不再只由人给。
// 所以这里只给证据，动手是 Owner 的 amend。
import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { reqIntake, reqApprove, pathIntake, pathPrunePreview } from "../src/store.js";
import { makeRepo } from "./helpers.js";

/** 按现在（还没改并集）的批准口径造数据：需求验收里的命令会被并进契约。 */
function approvedPath({ acceptance = ["npm --prefix apps/desktop run build :: exit==0"], testCmds = ["node --test docs/spikes/x.test.mjs"] } = {}) {
  const root = makeRepo();
  const db = openDb(root);
  const req = reqIntake(db, root, { type: "requirement", title: "阶段需求", goal: "g", acceptance });
  const p = pathIntake(db, root, { requirementId: req.id, allowedPaths: ["docs/spikes"], testCmds, allowNewFiles: false });
  reqApprove(db, root, { requirementId: req.id, pathId: p.pathId });
  return { root, db, reqId: req.id, pathId: p.pathId };
}

test("预览只读：不写库、不改契约提交", () => {
  const { root, db, pathId } = approvedPath();
  const before = db.prepare("SELECT hash, contract_commit FROM paths WHERE id=?").get(pathId);
  const eventsBefore = db.prepare("SELECT COUNT(*) c FROM events").get().c;
  pathPrunePreview(db, root, { pathId });
  const after = db.prepare("SELECT hash, contract_commit FROM paths WHERE id=?").get(pathId);
  assert.deepEqual(after, before, "预览不许改 paths 行");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM events").get().c, eventsBefore, "预览不许写审计事件");
  db.close();
});

test("名不副实的命令要被点出来（真实现场：Desktop 构建落在只授权 docs/spikes 的 Path 上）", () => {
  const { root, db, pathId } = approvedPath();
  const r = pathPrunePreview(db, root, { pathId });
  assert.equal(r.removable, 1);
  assert.equal(r.prune[0].command, "npm --prefix apps/desktop run build");
  assert.deepEqual(r.prune[0].outside, ["apps/desktop"]);
  assert.deepEqual(r.keep, ["node --test docs/spikes/x.test.mjs"]);
  assert.match(r.note, /amend/);
  db.close();
});

test("命令都对得上时说没有要摘的（不制造噪音）", () => {
  const { root, db, pathId } = approvedPath({
    acceptance: ["node --test docs/spikes/x.test.mjs :: exit==0"],
    testCmds: ["node --test docs/spikes/x.test.mjs"],
  });
  const r = pathPrunePreview(db, root, { pathId });
  assert.equal(r.removable, 0);
  assert.deepEqual(r.prune, []);
  assert.match(r.note, /没有要摘的/);
  db.close();
});

test("只针对已批准的 Path：草稿没有契约可看", () => {
  const root = makeRepo();
  const db = openDb(root);
  const req = reqIntake(db, root, { type: "requirement", title: "草稿", goal: "g", acceptance: ["npm test :: exit==0"] });
  const p = pathIntake(db, root, { requirementId: req.id, allowedPaths: ["docs"], testCmds: ["npm test"], allowNewFiles: false });
  assert.throws(() => pathPrunePreview(db, root, { pathId: p.pathId }), (e) => e.code === "E_NEED_APPROVED");
  db.close();
});