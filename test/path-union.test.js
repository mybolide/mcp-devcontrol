// devcontrol — 批准 Path 时的命令并集开关（P0-2 的第一步，默认不动老行为）
//
// 历史行为：批准 Path 时把**需求验收的全部命令**并进契约。好处是任务随便引用哪条需求
// 验收都不会被 E_CONTRACT 拦；坏处是「这条 Path 属于哪个阶段」被抹平了——P-002 只授权
// docs/spikes，却带着 `cargo test -p agent-studio-acp` 和 Desktop 构建。
//
// 关闭后：Path 只冻结自己声明的命令。这是目标形态，但会让「需求验收里有、没有 Path
// 声明」的命令暂时建不出任务，所以做成 Owner 可控的开关，默认保持 on。
import test from "node:test";
import { taskCreate } from "../src/gates.js";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { reqIntake, reqApprove, pathIntake, pathApprove, listPaths, setPathUnion, pathUnionOn } from "../src/store.js";
import { makeRepo } from "./helpers.js";

function fixture() {
  const root = makeRepo();
  const db = openDb(root);
  const req = reqIntake(db, root, {
    type: "requirement",
    title: "两段验收",
    goal: "g",
    acceptance: ["npm test :: exit==0", "npm run build :: exit==0"],
  });
  const p = pathIntake(db, root, { requirementId: req.id, allowedPaths: ["src"], testCmds: ["npm test"], allowNewFiles: false });
  return { root, db, reqId: req.id, pathId: p.pathId };
}

test("默认仍然是并集（老项目当天不会被改坏）", () => {
  const { root, db, reqId, pathId } = fixture();
  assert.equal(pathUnionOn(db), true);
  reqApprove(db, root, { requirementId: reqId, pathId });
  const row = listPaths(db).find((x) => x.id === pathId);
  assert.deepEqual([...row.testCmds].sort(), ["npm run build", "npm test"], "默认行为不变：需求验收一起冻进来");
  db.close();
});

test("关掉之后：Path 只冻结自己声明的命令", () => {
  const { root, db, reqId, pathId } = fixture();
  setPathUnion(db, false);
  reqApprove(db, root, { requirementId: reqId, pathId });
  const row = listPaths(db).find((x) => x.id === pathId);
  assert.deepEqual(row.testCmds, ["npm test"], "需求里的 npm run build 不再被塞进这条 Path");
  assert.equal(pathUnionOn(db), false);
  db.close();
});

test("开关留审计：以后得说清新契约是按哪个口径冻的", () => {
  const { db } = fixture();
  setPathUnion(db, false);
  setPathUnion(db, true);
  const events = db.prepare("SELECT detail FROM events WHERE action='path.union' ORDER BY id").all().map((e) => e.detail);
  assert.equal(events.length, 2);
  assert.match(events[0], /off/);
  assert.match(events[1], /on/);
  db.close();
});

test("关掉后旧契约不被改写（历史不动）", () => {
  const { root, db, reqId, pathId } = fixture();
  reqApprove(db, root, { requirementId: reqId, pathId });
  const before = db.prepare("SELECT hash, contract_commit, test_cmds_json FROM paths WHERE id=?").get(pathId);
  setPathUnion(db, false);
  const after = db.prepare("SELECT hash, contract_commit, test_cmds_json FROM paths WHERE id=?").get(pathId);
  assert.deepEqual(after, before, "翻开关只影响以后批准的 Path");
  db.close();
});

test("union=off 时建不出「没人声明」的命令：错误里要说清该补哪一层", () => {
  const { root, db, reqId, pathId } = fixture();
  setPathUnion(db, false);
  reqApprove(db, root, { requirementId: reqId, pathId });
  // 需求第二条验收（npm run build）现在没有任何 Path 声明
  let err = null;
  try {
    taskCreate(db, root, {
      requirementId: reqId,
      pathId,
      title: "把构建跑绿",
      acceptance: [{ deriveFrom: 1, assertion: "npm run build :: exit==0" }],
      scope: ["src"],
    });
  } catch (e) {
    err = e;
  }
  assert.equal(err?.code, "E_CONTRACT");
  assert.match(err.message, /npm run build/);
  assert.match(err.data.hint, /新建一条/, "要说清是给这个阶段补 Path");
  assert.match(err.data.hint, /path union/, "也要点出这是并集关掉之后的正常结果");
  db.close();
});