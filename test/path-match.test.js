// devcontrol — Path 精确匹配与验收继承
//
// 现场（agent studio）：FR-007 有 P-002 / P-006 / P-007 三条 approved Path。
// 老逻辑取「这条需求的第一条 approved」，于是 status/next 一律推荐 P-002——
// Agent 照抄要么撞 scope，要么被迫跑别家阶段的验收。
//
// 注意：`pathApprove` 目前会把**需求验收里的命令全并进每条 Path**（见最后一条测试），
// 所以真实库里三条 Path 的命令几乎一样，靠命令区分不出来。把这一步拆开是 P0-2 的事；
// 这里的匹配逻辑按「Path 只冻结自己阶段的命令」来写，正是 P0-2 之后的目标形状。
import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { reqIntake, reqApprove, pathIntake, pathApprove, listPaths } from "../src/store.js";
import { bootstrap } from "../src/digest.js";
import { matchPathForAssertion, pathCoversAssertion } from "../src/pathmatch.js";
import { commandPaths, acceptScopeWarnings } from "../src/acceptance.js";
import { makeRepo } from "./helpers.js";

/** 直接写 paths 表：按「Path 只冻结自己阶段命令」的目标形状造数据。 */
function seedPaths(db, reqId, specs) {
  const insert = db.prepare(
    "INSERT INTO paths(id,requirement_id,allowed_paths_json,allow_new_files,budget_lines,test_cmds_json,status) VALUES(?,?,?,0,1200,?,'approved')",
  );
  for (const s of specs) insert.run(s.id, reqId, JSON.stringify(s.allowedPaths), JSON.stringify(s.testCmds));
}

function twoStageReq() {
  const root = makeRepo();
  const db = openDb(root);
  const req = reqIntake(db, root, {
    type: "requirement",
    title: "两阶段需求",
    goal: "先查格式，再跑测试",
    acceptance: ["git diff --check :: exit==0", "npm test :: exit==0"],
  });
  // 需求得是 approved 才会进 coverage；批准时只挂一条最窄的 Path，另一条直接补进表里。
  const p1 = pathIntake(db, root, { requirementId: req.id, allowedPaths: ["src"], testCmds: ["npm test"], allowNewFiles: false });
  reqApprove(db, root, { requirementId: req.id, pathId: p1.pathId });
  // 模拟 P0-2 之后的状态：Path 上只留它自己阶段的命令。
  // （现在的 approve 会把需求验收并进每条 Path，见最后一条测试——那一步是 P0-2 要拆的。）
  db.prepare("UPDATE paths SET test_cmds_json=? WHERE id=?").run(JSON.stringify(["npm test"]), p1.pathId);
  seedPaths(db, req.id, [{ id: "P-900", allowedPaths: ["docs"], testCmds: ["git diff --check"] }]);
  return { root, db, reqId: req.id, p1: p1.pathId, p2: "P-900" };
}

test("多条 approved Path：next 选能履行这条验收的那条，不选列表里第一条", () => {
  const { root, db, p1, p2 } = twoStageReq();
  const next = bootstrap(db, root).next;
  assert.equal(next.action, "task.create");
  assert.equal(next.args.pathId, p2, `应当选冻结了 git diff --check 的 ${p2}，而不是列表里第一条 ${p1}`);
  assert.equal(next.args.acceptance[0].assertion, "git diff --check :: exit==0");
});

test("status 里的 Path 只属于当前需求，并带上是哪一条、能跑什么", () => {
  const { root, db, reqId, p2 } = twoStageReq();
  const d = bootstrap(db, root);
  assert.equal(d.requirement.id, reqId, "显示的需求应当是「有缺口的那条」");
  assert.ok(d.path, "有缺口时 path 不该是 null");
  assert.equal(d.path.id, p2, "path 必须是有缺口那条需求里能履行验收的那条");
  assert.equal(d.path.requirementId, reqId, "path 必须带 requirementId：否则看不出它属于谁");
  assert.deepEqual(d.path.commands, ["git diff --check"]);
});

test("多条 Path 都能跑这条验收时不猜：给出候选让人按文件挑", () => {
  // 真实库里每条 Path 都被并进了需求验收的全部命令（见最后一条测试），
  // 这时候「挑一条」等于瞎猜——猜错就是给错授权范围。
  const root = makeRepo();
  const db = openDb(root);
  const req = reqIntake(db, root, { type: "requirement", title: "并集需求", goal: "g", acceptance: ["npm test :: exit==0"] });
  const p = pathIntake(db, root, { requirementId: req.id, allowedPaths: ["src"], testCmds: ["npm test"], allowNewFiles: false });
  reqApprove(db, root, { requirementId: req.id, pathId: p.pathId });
  seedPaths(db, req.id, [{ id: "P-901", allowedPaths: ["docs"], testCmds: ["npm test"] }]);
  const next = bootstrap(db, root).next;
  assert.equal(next.action, "wait", "两条都能跑就别假装知道该用哪条");
  assert.match(next.why, /内核不替你选/);
  assert.deepEqual(next.pathDiagnostics.map((c) => c.id).sort(), [p.pathId, "P-901"].sort());
  db.close();
});

test("选不出来就明说差在哪，不静默推荐一条错误 Path", () => {
  const paths = [
    { id: "P-001", status: "approved", requirement_id: "FR-001", allowedPaths: ["docs/spikes/a.mjs"], testCmds: ["npm test"] },
  ];
  const m = matchPathForAssertion({ paths, requirementId: "FR-001", assertion: "cargo test -p agent-studio-acp :: exit==0" });
  assert.equal(m.path, null);
  assert.match(m.reason, /cargo test -p agent-studio-acp/);
  assert.equal(m.candidates.length, 1);
  assert.match(m.candidates[0].why, /冻结命令 npm test/);
});

test("跨需求的 Path 一律不认：哪怕它冻结了这条命令", () => {
  const paths = [
    { id: "P-001", status: "approved", requirement_id: "FR-001", allowedPaths: ["docs"], testCmds: ["npm test"] },
    { id: "P-002", status: "approved", requirement_id: "FR-002", allowedPaths: ["src"], testCmds: ["npm test"] },
  ];
  const m = matchPathForAssertion({ paths, requirementId: "FR-001", assertion: "npm test :: exit==0" });
  assert.equal(m.path.id, "P-001", "只能在自己的需求里选");
  const none = matchPathForAssertion({ paths, requirementId: "FR-003", assertion: "npm test :: exit==0" });
  assert.equal(none.path, null, "没有自己的 Path 就是没有，不能借别家的");
});

test("命中多条时取范围最窄的那条", () => {
  const paths = [
    { id: "P-001", status: "approved", requirement_id: "FR-001", allowedPaths: [".", "src", "docs"], testCmds: ["npm test"] },
    { id: "P-002", status: "approved", requirement_id: "FR-001", allowedPaths: ["src"], testCmds: ["npm test"] },
  ];
  const m = matchPathForAssertion({ paths, requirementId: "FR-001", assertion: "npm test :: exit==0" });
  assert.equal(m.path.id, "P-002");
  assert.equal(pathCoversAssertion(paths[1], "npm test :: exit==0"), true);
  assert.equal(pathCoversAssertion(paths[1], "npm run build :: exit==0"), false);
});

test("命令里带的路径要能被认出来（判断验收与 scope 是否对得上）", () => {
  assert.deepEqual(commandPaths("npm --prefix apps/desktop run build"), ["apps/desktop"]);
  assert.deepEqual(commandPaths("cargo test -p agent-studio-acp --locked"), []);
  assert.deepEqual(commandPaths("node --test docs/spikes/plugin-contract.test.mjs"), ["docs/spikes/plugin-contract.test.mjs"]);
});

test("验收命令碰的路径不在 scope 里时给诊断（不拦，但要说清怎么改）", () => {
  const warn = acceptScopeWarnings({
    acceptance: [{ assertion: "npm --prefix apps/desktop run build :: exit==0" }],
    scope: ["crates/agent-studio-provider"],
    path: { id: "P-007" },
  });
  assert.equal(warn.length, 1);
  assert.equal(warn[0].id, "accept-scope-mismatch");
  assert.match(warn[0].detail, /apps\/desktop/);
  assert.match(warn[0].fix, /P-007/);
  assert.deepEqual(
    acceptScopeWarnings({ acceptance: [{ assertion: "npm --prefix apps/desktop run build :: exit==0" }], scope: ["apps/desktop/src"], path: { id: "P-006" } }),
    [],
  );
});

test("现状钉住（P0-2 待改）：批准 Path 时会把需求验收的命令并进每条 Path", () => {
  // 这一条**记录的是要改掉的行为**，不是想要的规范：
  // P-002 只干 docs/spikes，却拿到了 `cargo test -p agent-studio-acp`，
  // 于是「按命令挑 Path」在真实库上区分不出来。P0-2 撤掉这个并集后，这条测试要反过来断言。
  const root = makeRepo();
  const db = openDb(root);
  const req = reqIntake(db, root, {
    type: "requirement",
    title: "并集现状",
    goal: "g",
    acceptance: ["git diff --check :: exit==0", "npm test :: exit==0"],
  });
  const p = pathIntake(db, root, { requirementId: req.id, allowedPaths: ["docs/spikes"], testCmds: ["git diff --check"], allowNewFiles: false });
  reqApprove(db, root, { requirementId: req.id, pathId: p.pathId });
  const row = listPaths(db).find((x) => x.id === p.pathId);
  assert.deepEqual([...row.testCmds].sort(), ["git diff --check", "npm test"], "现在 Path 会把需求验收一并吃掉（P0-2 要拆开）");
  db.close();
});