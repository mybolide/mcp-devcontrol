// devcontrol — 验收命令不能一辈子用 init 那一刻采的那条
//
// 事实：项目会变。test 脚本从 `node --test tests/` 换成 `node --test`（Node 24 不认目录参数），
// 或者从 npm 换到 pnpm。契约里冻的命令一过期，收口跑的就是一条不存在的命令——
// Agent 只看到「失败」，查不出原因。所以需要能重采，也需要 doctor 提前喊。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { openDb } from "../src/db.js";
import { reqIntake, reqApprove, pathRetest, listPaths, listTasks, getTask } from "../src/store.js";
import { taskCreate } from "../src/gates.js";
import { doctor } from "../src/report.js";
import { detectTestCmds, retargetAssertion, assertionCommand } from "../src/testcmd.js";
import { makeRepo } from "./helpers.js";

const flow = (root, { testCmd = "npm test" } = {}) => {
  const db = openDb(root);
  db.prepare("INSERT INTO paths(id,allowed_paths_json,allow_new_files,budget_lines,test_cmds_json,status) VALUES('P-001',?,0,1200,?,'draft')").run(
    JSON.stringify(["src"]),
    JSON.stringify([testCmd]),
  );
  const req = reqIntake(db, root, { type: "requirement", title: "r", goal: "g", acceptance: [`${testCmd} :: exit==0`] });
  reqApprove(db, root, { requirementId: req.id, pathId: "P-001" });
  return { db, reqId: req.id };
};

test("detectTestCmds：按 package.json 的 test 脚本采，并跟随包管理器", () => {
  const root = makeRepo();
  assert.deepEqual(detectTestCmds(root), { cmds: ["npm test"], source: "package.json scripts.test（npm test）" });
  // 换成 pnpm：命令要跟着换，否则跑的是另一个包管理器的语义
  fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "");
  assert.deepEqual(detectTestCmds(root).cmds, ["pnpm test"]);
});

test("detectTestCmds：没有 package.json 时按语言事实标准；什么都没有就返回空", () => {
  const rust = makeRepo();
  fs.rmSync(path.join(rust, "package.json"));
  fs.writeFileSync(path.join(rust, "Cargo.toml"), "[package]\nname='x'\n");
  assert.deepEqual(detectTestCmds(rust).cmds, ["cargo test"]);

  const bare = makeRepo();
  fs.rmSync(path.join(bare, "package.json"));
  const none = detectTestCmds(bare);
  assert.deepEqual(none.cmds, []);
  assert.match(none.note, /控制台/);
});

test("detectTestCmds：package.json 坏掉不能静默当成没有测试", () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "package.json"), "{ 坏 json");
  const got = detectTestCmds(root);
  assert.deepEqual(got.cmds, []);
  assert.match(got.note, /不是合法 JSON/);
});

test("retargetAssertion 只换命令，谓词原样保留", () => {
  assert.equal(retargetAssertion("npm test :: exit==0", "pnpm test"), "pnpm test :: exit==0");
  assert.equal(retargetAssertion("npm test :: stdout =~ /ok/", "make test"), "make test :: stdout =~ /ok/");
  assert.equal(retargetAssertion("没冒号的怪东西", "x"), "没冒号的怪东西");
  assert.equal(assertionCommand("npm test :: exit==0"), "npm test");
});

test("path.retest 更新契约，并把还没开工的任务的断言一起换掉", () => {
  const root = makeRepo();
  const { db, reqId } = flow(root);
  const t = taskCreate(db, root, {
    requirementId: reqId,
    pathId: "P-001",
    kind: "feature",
    title: "改 a.js",
    acceptance: [{ deriveFrom: 0, assertion: "npm test :: exit==0" }],
    scope: ["src"],
  });

  const res = pathRetest(db, root, { pathId: "P-001", testCmds: ["pnpm test"], reason: "项目从 npm 换到 pnpm 了，命令得跟着换" });
  assert.deepEqual(res.to, ["pnpm test"]);
  assert.deepEqual(res.retargeted, [t.id], "没开工的任务要跟着换命令");
  assert.deepEqual(res.stuck, []);
  assert.deepEqual(listPaths(db).find((p) => p.id === "P-001").testCmds, ["pnpm test"]);
  // 谓词是验收标准，不能顺手改掉
  assert.equal(getTask(db, t.id).acceptance[0].assertion, "pnpm test :: exit==0");
  assert.equal(getTask(db, t.id).acceptance[0].deriveFrom, 0, "deriveFrom 不能被清掉");
});

test("path.retest 动不了已经在办的任务：它 pin 了旧契约，报出来让人决定", () => {
  const root = makeRepo();
  const { db, reqId } = flow(root);
  const t = taskCreate(db, root, {
    requirementId: reqId,
    pathId: "P-001",
    kind: "feature",
    title: "改 a.js",
    acceptance: [{ deriveFrom: 0, assertion: "npm test :: exit==0" }],
    scope: ["src"],
  });
  db.prepare("UPDATE tasks SET status='doing' WHERE id=?").run(t.id);

  const res = pathRetest(db, root, { pathId: "P-001", testCmds: ["pnpm test"], reason: "换包管理器了，命令一起换掉" });
  assert.deepEqual(res.stuck, [t.id], "在办任务不能被偷偷改断言");
  assert.deepEqual(res.retargeted, []);
  assert.equal(getTask(db, t.id).acceptance[0].assertion, "npm test :: exit==0", "在办任务的断言原样保留");
});

test("path.retest 必须写理由，且采不到命令时要报错而不是清空", () => {
  const root = makeRepo();
  const { db } = flow(root);
  assert.throws(() => pathRetest(db, root, { pathId: "P-001", testCmds: ["pnpm test"], reason: "短" }), (e) => e.code === "E_CONTRACT");

  fs.rmSync(path.join(root, "package.json"));
  assert.throws(
    () => pathRetest(db, root, { pathId: "P-001", reason: "项目里已经没有可用的验收命令了" }),
    (e) => e.code === "E_NO_TEST_CMD",
  );
  assert.deepEqual(listPaths(db).find((p) => p.id === "P-001").testCmds, ["npm test"], "失败时不能把原命令弄丢");
});

test("doctor 发现验收命令漂移：项目换了 test 脚本，契约还冻着旧的", () => {
  const root = makeRepo();
  const { db } = flow(root);
  assert.equal(doctor(db, root).filter((i) => i.code === "TEST_CMD_DRIFT").length, 0, "一致时不该报警");

  fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "");
  const drift = doctor(db, root).filter((i) => i.code === "TEST_CMD_DRIFT");
  assert.equal(drift.length, 1);
  assert.match(drift[0].detail, /pnpm test/);

  // 重采之后应当自我修复
  pathRetest(db, root, { pathId: "P-001", reason: "按项目现状把命令重采一遍，别让收口跑空" });
  assert.equal(doctor(db, root).filter((i) => i.code === "TEST_CMD_DRIFT").length, 0);
});

test("重采后新建的任务能直接用新命令（白名单已经跟着换了）", () => {
  const root = makeRepo();
  const { db, reqId } = flow(root);
  pathRetest(db, root, { pathId: "P-001", testCmds: ["pnpm test"], reason: "换包管理器了，命令一起换掉" });
  const t = taskCreate(db, root, {
    requirementId: reqId,
    pathId: "P-001",
    kind: "feature",
    title: "新任务",
    acceptance: [{ deriveFrom: 0, assertion: "pnpm test :: exit==0" }],
    scope: ["src"],
  });
  assert.equal(getTask(db, t.id).acceptance[0].assertion, "pnpm test :: exit==0");
  assert.ok(listTasks(db).some((x) => x.id === t.id));
});