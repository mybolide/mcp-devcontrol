// devcontrol — 可交付性回归：Path 复用 / next.args 可执行 / CLI 建领任务 / kind 取值
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { openDb } from "../src/db.js";
import { reqIntake, reqApprove, getTask, listTasks } from "../src/store.js";
import { taskCreate, taskClaim } from "../src/gates.js";
import { bootstrap } from "../src/digest.js";
import { makeRepo, initFlow, newTask, sh, BIN } from "./helpers.js";

const ACCEPT = { deriveFrom: 0, assertion: "npm test :: exit==0" };

/** 一条 draft Path（不写契约），用于 Path 复用场景 */
function draftPath(db, allowed = ["src"]) {
  db.prepare("INSERT INTO paths(id,allowed_paths_json,allow_new_files,budget_lines,test_cmds_json,status) VALUES('P-001',?,0,1200,?,'draft')").run(
    JSON.stringify(allowed),
    JSON.stringify(["npm test"]),
  );
}

test("Path 可被多个需求复用：第二个需求能直接批准并建任务", () => {
  const root = makeRepo();
  const db = openDb(root);
  draftPath(db);

  const r1 = reqIntake(db, root, { type: "requirement", title: "需求一", goal: "g", acceptance: ["npm test :: exit==0"] });
  reqApprove(db, root, { requirementId: r1.id, pathId: "P-001" });

  const r2 = reqIntake(db, root, { type: "requirement", title: "需求二", goal: "g", acceptance: ["npm test :: exit==0"] });
  assert.doesNotThrow(() => reqApprove(db, root, { requirementId: r2.id, pathId: "P-001" }), "已批准的 Path 不该再报 E_ILLEGAL_TRANSITION");

  const t = taskCreate(db, root, { requirementId: r2.id, pathId: "P-001", kind: "feature", title: "第二个需求的任务", scope: ["src"], acceptance: [ACCEPT] });
  assert.equal(t.requirement_id, r2.id);
  assert.equal(t.path_id, "P-001");
});

test("kind 归一：fix→bugfix，未知值明确报错而不是静默变成 feature", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const mk = (kind) => taskCreate(db, root, { requirementId: reqId, pathId: "P-001", kind, title: `x-${kind}`, scope: ["src"], acceptance: [ACCEPT] });

  assert.equal(mk("fix").kind, "bugfix");
  assert.equal(mk("feat").kind, "feature");
  assert.equal(mk("refactor").kind, "chore");
  assert.throws(() => mk("乱七八糟"), (e) => e.code === "INVALID_ARGUMENT");
});

test("next.args 可以直接执行：task.create → task.claim 都不报错", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);

  // 有已批准需求但没任务：next 应该是 task.create，且参数齐全
  const first = bootstrap(db, root).next;
  assert.equal(first.action, "task.create");
  assert.equal(first.args.requirementId, reqId);
  assert.ok(first.args.pathId, "next.args 必须带 pathId");
  assert.ok(first.args.title, "next.args 必须带 title");
  assert.deepEqual(first.args.scope, ["src"], "scope 来自 Path 的 allowedPaths");

  const created = taskCreate(db, root, first.args); // 原样执行
  assert.ok(created.id);

  // 有可领取任务：next 应该是 task.claim，原样执行即可
  const second = bootstrap(db, root).next;
  assert.equal(second.action, "task.claim");
  assert.equal(second.args.id, created.id);
  assert.doesNotThrow(() => taskClaim(db, root, second.args, "agent"));
  assert.equal(getTask(db, created.id).status, "doing");

  // 在办：next 应该是 task.close
  assert.equal(bootstrap(db, root).next.action, "task.close");
});

test("纯 CLI 能建任务与领任务（init --no-mcp 之后）", () => {
  const root = makeRepo();
  const { reqId } = initFlow(root);
  const cli = (...args) => sh(root, process.execPath, BIN, ...args);

  const out = cli("task", "create", "--req", reqId, "--path", "P-001", "--title", "CLI 建的任务", "--scope", "src", "--accept", "npm test :: exit==0");
  const id = out.match(/T-\d+/)?.[0];
  assert.ok(id, `CLI 没吐出任务号：${out}`);

  const claimed = cli("task", "claim", id, "--actor", "cli-agent");
  assert.match(claimed, /已领取/);

  const db = openDb(root);
  const task = getTask(db, id);
  assert.equal(task.status, "doing");
  assert.equal(task.claimed_by, "cli-agent");
  assert.ok(listTasks(db).some((t) => t.id === id));

  const next = cli("next");
  assert.match(next, /task\.close/, "在办时 next 应该是收口");
  assert.ok(fs.existsSync(path.join(root, ".devcontrol", "state.db")));
});

test("脚手架：init 只生成一条覆盖全项目的根 Path", () => {
  const root = makeRepo();
  execFileSync(process.execPath, [BIN, "init", "--no-mcp"], { cwd: root, encoding: "utf8" });
  const db = openDb(root);
  const paths = db.prepare("SELECT id,allowed_paths_json FROM paths").all();
  assert.equal(paths.length, 1, `应只有一条 Path，实际 ${paths.length}`);
  assert.deepEqual(JSON.parse(paths[0].allowed_paths_json), ["."]);
});
