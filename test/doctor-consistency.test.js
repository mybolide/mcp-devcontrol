// devcontrol — doctor 的自洽检查：只看内核自己记的东西对不对，不看仓库
//
// 为什么单开一组：其他检查都在问「Agent 做了什么」，这一组在问「内核自己有没有前后矛盾」。
// 2026-11 的全栈演练里出现过一次典型故障：Owner 在需求验收里写了 npm run build，
// 批准时却只冻结了 npm test，于是 Agent 建任何用 build 验收的任务都被 E_CONTRACT 拦住，
// 而错误里完全看不出「这是 Owner 早就批准过的」。
// 那种状态两个人都不觉得自己做错、页面也都正常，只有把两边摊在一起比对才看得见。
import test from "node:test";
import assert from "node:assert/strict";
import { makeRepo } from "./helpers.js";
import { openDb } from "../src/db.js";
import { reqIntake, reqApprove, listPaths } from "../src/store.js";
import { taskCreate } from "../src/gates.js";
import { doctor } from "../src/report.js";

const codes = (items) => items.map((i) => i.code);
const mkPath = (db, { allowed = ["src"], cmds = ["npm test"] } = {}) =>
  db
    .prepare("INSERT INTO paths(id,allowed_paths_json,allow_new_files,budget_lines,test_cmds_json,status) VALUES('P-001',?,0,1200,?,'draft')")
    .run(JSON.stringify(allowed), JSON.stringify(cmds));

const req = (db, root, acceptance = ["npm test :: exit==0"]) =>
  reqIntake(db, root, { type: "requirement", title: "r", acceptance });

test("一致的项目不报任何自洽问题", () => {
  const root = makeRepo();
  const db = openDb(root);
  mkPath(db);
  reqApprove(db, root, { requirementId: req(db, root).id, pathId: "P-001" });
  const items = doctor(db, root).filter((i) => /ACCEPTANCE_|TASK_|REQ_WITHOUT/.test(i.code));
  assert.deepEqual(codes(items), []);
});

test("需求验收里有契约没冻结的命令 → ACCEPTANCE_NOT_IN_CONTRACT", () => {
  const root = makeRepo();
  const db = openDb(root);
  mkPath(db, { cmds: ["npm test"] });
  const r = req(db, root, ["npm test :: exit==0", "npm run build :: exit==0"]);
  reqApprove(db, root, { requirementId: r.id, pathId: "P-001" });
  // 把契约改回「只冻结 test」，模拟 T-059 的事故现场
  db.prepare("UPDATE paths SET test_cmds_json=? WHERE id='P-001'").run(JSON.stringify(["npm test"]));

  const hit = doctor(db, root).find((i) => i.code === "ACCEPTANCE_NOT_IN_CONTRACT");
  assert.ok(hit, "应报出不一致");
  assert.equal(hit.severity, "error");
  assert.match(hit.detail, /npm run build/);
});

test("批准时自动合并，所以正常流程根本不会产生这条不一致", () => {
  const root = makeRepo();
  const db = openDb(root);
  mkPath(db, { cmds: ["npm test"] });
  const r = req(db, root, ["npm test :: exit==0", "npm run build :: exit==0"]);
  reqApprove(db, root, { requirementId: r.id, pathId: "P-001" });
  assert.deepEqual(listPaths(db)[0].testCmds.sort(), ["npm run build", "npm test"]);
  assert.deepEqual(codes(doctor(db, root).filter((i) => i.code === "ACCEPTANCE_NOT_IN_CONTRACT")), []);
});

test("任务的断言命令不在契约里 → TASK_ASSERTION_DRIFT（这条任务收不了口）", () => {
  const root = makeRepo();
  const db = openDb(root);
  mkPath(db, { cmds: ["npm test"] });
  const r = req(db, root);
  reqApprove(db, root, { requirementId: r.id, pathId: "P-001" });
  taskCreate(db, root, {
    requirementId: r.id,
    pathId: "P-001",
    title: "用了契约外的命令",
    scope: ["src"],
    acceptance: [{ deriveFrom: 0, assertion: "npm test :: exit==0" }],
  });
  // 绕过 taskCreate 的校验，直接改成契约外的命令（模拟历史数据/手工改库）
  db.prepare("UPDATE tasks SET acceptance_json=? WHERE id='T-001'").run(
    JSON.stringify([{ deriveFrom: 0, assertion: "npm run build :: exit==0" }]),
  );
  const hit = doctor(db, root).find((i) => i.code === "TASK_ASSERTION_DRIFT");
  assert.ok(hit, "应报出任务断言漂移");
  assert.match(hit.detail, /收不了口/);
});

test("任务 scope 超出 Path 区域 → TASK_SCOPE_OUTSIDE_PATH", () => {
  const root = makeRepo();
  const db = openDb(root);
  mkPath(db, { allowed: ["src"] });
  const r = req(db, root);
  reqApprove(db, root, { requirementId: r.id, pathId: "P-001" });
  taskCreate(db, root, {
    requirementId: r.id,
    pathId: "P-001",
    title: "越界任务",
    scope: ["src"],
    acceptance: [{ deriveFrom: 0, assertion: "npm test :: exit==0" }],
  });
  db.prepare("UPDATE tasks SET scope_json=? WHERE id='T-001'").run(JSON.stringify(["docs"]));
  const hit = doctor(db, root).find((i) => i.code === "TASK_SCOPE_OUTSIDE_PATH");
  assert.ok(hit, "应报出 scope 越界");
  assert.match(hit.detail, /docs/);
});

test("依赖不存在的任务 → TASK_DEP_UNKNOWN", () => {
  const root = makeRepo();
  const db = openDb(root);
  mkPath(db);
  const r = req(db, root);
  reqApprove(db, root, { requirementId: r.id, pathId: "P-001" });
  const t = taskCreate(db, root, {
    requirementId: r.id,
    pathId: "P-001",
    title: "等幽灵",
    scope: ["src"],
    acceptance: [{ deriveFrom: 0, assertion: "npm test :: exit==0" }],
  });
  db.prepare("UPDATE tasks SET depends_on_json=? WHERE id=?").run(JSON.stringify(["T-999"]), t.id);
  assert.ok(codes(doctor(db, root)).includes("TASK_DEP_UNKNOWN"));
});

test("依赖成环 → TASK_DEP_CYCLE（成环等于永远没人能开工）", () => {
  const root = makeRepo();
  const db = openDb(root);
  mkPath(db);
  const r = req(db, root);
  reqApprove(db, root, { requirementId: r.id, pathId: "P-001" });
  const a = taskCreate(db, root, {
    requirementId: r.id, pathId: "P-001", title: "A", scope: ["src"],
    acceptance: [{ deriveFrom: 0, assertion: "npm test :: exit==0" }],
  });
  const b = taskCreate(db, root, {
    requirementId: r.id, pathId: "P-001", title: "B", scope: ["src"],
    acceptance: [{ deriveFrom: 0, assertion: "npm test :: exit==0" }],
  });
  db.prepare("UPDATE tasks SET depends_on_json=? WHERE id=?").run(JSON.stringify([b.id]), a.id);
  db.prepare("UPDATE tasks SET depends_on_json=? WHERE id=?").run(JSON.stringify([a.id]), b.id);
  const hit = doctor(db, root).find((i) => i.code === "TASK_DEP_CYCLE");
  assert.ok(hit, "应报出依赖成环");
  assert.match(hit.detail, /→/);
});

test("已批准的需求没有 Path 绑着 → REQ_WITHOUT_PATH", () => {
  const root = makeRepo();
  const db = openDb(root);
  mkPath(db);
  const r = req(db, root);
  reqApprove(db, root, { requirementId: r.id, pathId: "P-001" });
  db.prepare("UPDATE paths SET requirement_id=NULL WHERE id='P-001'").run();
  assert.ok(codes(doctor(db, root)).includes("REQ_WITHOUT_PATH"));
});

test("自洽检查读得出对象和字符串两种 acceptance，不会静默失效", () => {
  // 任务的 acceptance 是 {assertion} 对象数组，需求的是字符串数组。
  // 混着用会让 assertionCommand 拿到 [object Object] 静默返回 null —— 那样这组检查就是摆设。
  const root = makeRepo();
  const db = openDb(root);
  mkPath(db, { cmds: ["npm test"] });
  const r = req(db, root, ["npm run build :: exit==0"]);
  reqApprove(db, root, { requirementId: r.id, pathId: "P-001" });
  db.prepare("UPDATE paths SET test_cmds_json=? WHERE id='P-001'").run(JSON.stringify(["npm test"]));
  assert.ok(codes(doctor(db, root)).includes("ACCEPTANCE_NOT_IN_CONTRACT"), "字符串来源必须被判出来");
});