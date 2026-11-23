// devcontrol — 测试夹具：临时仓库 + 最小「需求批准 → 任务」链路
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { openDb } from "../src/db.js";
import { reqIntake, reqApprove } from "../src/store.js";
import { recordEvidence, taskCreate } from "../src/gates.js";
import { assertionCommand } from "../src/testcmd.js";

export const BIN = path.join(import.meta.dirname, "..", "bin", "devcontrol.js");

export function sh(cwd, ...args) {
  return execFileSync(args[0], args.slice(1), { cwd, encoding: "utf8" });
}

export function makeRepo({ failTest = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mpk-"));
  sh(dir, "git", "init", "-q", ".");
  sh(dir, "git", "config", "user.email", "t@t");
  sh(dir, "git", "config", "user.name", "t");
  fs.mkdirSync(path.join(dir, "src"));
  const script = failTest ? 'node -e "process.exit(1)"' : 'node -e "process.exit(0)"';
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "d", version: "1.0.0", scripts: { test: script } }));
  fs.writeFileSync(path.join(dir, "src/a.js"), "export const a = 1;\n");
  sh(dir, "git", "add", "-A");
  sh(dir, "git", "commit", "-qm", "init");
  return dir;
}

/** 一个最小的 Go 项目仓库：go.mod + main.go + 一个必定通过的 go test */
export function makeGoRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mpk-go-"));
  fs.mkdirSync(path.join(dir, "cmd/app"), { recursive: true });
  fs.writeFileSync(path.join(dir, "go.mod"), "module example.com/demo\n\ngo 1.21\n");
  fs.writeFileSync(path.join(dir, "cmd/app/main.go"), "package main\n\nfunc main() {}\n");
  fs.writeFileSync(
    path.join(dir, "cmd/app/main_test.go"),
    'package main\n\nimport "testing"\n\nfunc TestOK(t *testing.T) {}\n',
  );
  sh(dir, "git", "init", "-q", ".");
  sh(dir, "git", "config", "user.email", "g@g");
  sh(dir, "git", "config", "user.name", "g");
  sh(dir, "git", "add", "-A");
  sh(dir, "git", "commit", "-qm", "init");
  return dir;
}

export function initFlow(root, { testCmd = "npm test", allowed = ["src"] } = {}) {
  const db = openDb(root);
  db.prepare("INSERT INTO paths(id,allowed_paths_json,allow_new_files,budget_lines,test_cmds_json,status) VALUES('P-001',?,0,1200,?,'draft')").run(
    JSON.stringify(allowed),
    JSON.stringify([testCmd]),
  );
  const req = reqIntake(db, root, { type: "requirement", title: "r", goal: "g", acceptance: [`${testCmd} :: exit==0`] });
  reqApprove(db, root, { requirementId: req.id, pathId: "P-001" });
  return { db, reqId: req.id };
}

export function newTask(db, root, reqId, extra = {}) {
  return taskCreate(db, root, {
    requirementId: reqId,
    pathId: "P-001",
    kind: "feature",
    title: "改 a.js",
    acceptance: [{ deriveFrom: 0, assertion: "npm test :: exit==0" }],
    scope: ["src"],
    ...extra,
  });
}
/**
 * 模拟「Agent 自己跑完测试、留下证据」。
 *
 * 内核不执行测试（工具只核验证据），所以测试里要让 close 通过，必须先把证据造出来。
 * exit 默认 0；要模拟验收失败就传 1。
 */
export function prove(db, root, taskId, { exit = 0, command = null, output = "" } = {}) {
  const task = db.prepare("SELECT scope_json, acceptance_json FROM tasks WHERE id=?").get(taskId);
  const scope = task ? JSON.parse(task.scope_json) : ["."];
  const cmds = command
    ? [command]
    : task
      ? JSON.parse(task.acceptance_json).map((a) => assertionCommand(a.assertion))
      : [];
  return cmds.map((c) =>
    recordEvidence(db, root, { taskId, command: c, result: { exit, stdout: output, stderr: "", durationMs: 1 }, scope }),
  );
}

/**
 * 夹具默认的交付说明。正常收口要求说明必填——那是产品约束，测试不该绕开它，
 * 只是把「这次交付了什么」补齐成一句真话。要测「缺说明会被拒」就显式传空。
 */
export const CLOSE_NOTE = {
  summary: "完成本任务声明的改动",
  changes: "见本次提交；夹具使用固定说明",
  limitations: "无",
};

/** 先交证据再收口：等价于 Agent 的正常动作顺序 */
export async function closeProven(db, root, input, { exit = 0, output = "", ...closeOpts } = {}) {
  const id = typeof input === "string" ? input : input.id;
  prove(db, root, id, { exit, output });
  const { taskClose } = await import("../src/gates.js");
  const merged = typeof input === "string" ? { id, ...CLOSE_NOTE } : { ...CLOSE_NOTE, ...input };
  return taskClose(db, root, merged, closeOpts);
}
