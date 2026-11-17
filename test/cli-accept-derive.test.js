// devcontrol — 一次 --accept 两条时，deriveFrom 必须各自对号入座
//
// linkwatch 内测抓到的真 bug：CLI 建任务时所有 --accept 共用同一个 deriveFrom（默认 0）。
// 于是一条任务同时断言「测试 + 构建」时，覆盖率只认第 0 条验收被覆盖，第 1 条永远显示没人管：
//   next 一直说「需求 FR-002 还有 1 条验收没有任务覆盖：npm run build」
// 而那条任务明明已经做完并收口了。Agent 照做就会建出重复任务。
//
// 覆盖率的语义是「需求验收的第几条有人管」，所以 deriveFrom 就是那个下标，必须按命令匹配。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { makeRepo, initFlow, BIN } from "./helpers.js";
import { openDb } from "../src/db.js";
import { coverage } from "../src/digest.js";
import { taskCreate } from "../src/gates.js";
import { reqIntake, reqApprove } from "../src/store.js";

const cli = (root, ...args) =>
  spawnSync(process.execPath, [BIN, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, DEVCONTROL_ROOT: root, DEVCONTROL_ACTOR: "cli-agent" },
  });

const deriveOf = (root, title) => {
  const db = openDb(root);
  const row = db.prepare("SELECT acceptance_json FROM tasks WHERE title=?").get(title);
  return JSON.parse(row.acceptance_json).map((a) => a.deriveFrom);
};

test("两条 --accept 分别指向需求验收的第 0、1 条", () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  // 两条验收走正常入口：批准时会把两条命令都冻进契约
  const r2 = reqIntake(db, root, { type: "requirement", title: "两条", acceptance: ["npm test :: exit==0", "npm build :: exit==0"] });
  reqApprove(db, root, { requirementId: r2.id, pathId: "P-001" });

  const r = cli(
    root,
    "task", "create", "--req", r2.id, "--path", "P-001", "--title", "两条验收",
    "--scope", "src", "--accept", "npm test :: exit==0", "--accept", "npm build :: exit==0",
  );
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(deriveOf(root, "两条验收"), [0, 1]);
});

test("覆盖率不会因为一个任务断言了两条而显示缺口", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const r2 = reqIntake(db, root, { type: "requirement", title: "两条", acceptance: ["npm test :: exit==0", "npm build :: exit==0"] });
  reqApprove(db, root, { requirementId: r2.id, pathId: "P-001" });

  const r = cli(
    root, "task", "create", "--req", r2.id, "--path", "P-001", "--title", "两条",
    "--scope", "src", "--accept", "npm test :: exit==0", "--accept", "npm build :: exit==0",
  );
  assert.equal(r.status, 0, r.stderr);

  const plan = coverage(db).find((p) => p.id === r2.id);
  assert.deepEqual(plan.missing, [], "两条验收都有人管，不该再让人去补拆");
});

test("显式给 --derive 时按给的来（不猜）", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const r2 = reqIntake(db, root, { type: "requirement", title: "两条", acceptance: ["npm test :: exit==0", "npm build :: exit==0"] });
  reqApprove(db, root, { requirementId: r2.id, pathId: "P-001" });
  const r = cli(
    root, "task", "create", "--req", r2.id, "--path", "P-001", "--title", "指定", "--scope", "src",
    "--accept", "npm build :: exit==0", "--derive", "0",
  );
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(deriveOf(root, "指定"), [0], "显式指定就该照办");
});

test("命令匹配不上时退回 0，不会写成 -1 把任务弄成收不了口", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  // 需求只有一条 test，但契约里也得有 build，才能建一条断言 build 的任务
  const r2 = reqIntake(db, root, { type: "requirement", title: "只测不构建", acceptance: ["npm test :: exit==0"] });
  reqApprove(db, root, { requirementId: r2.id, pathId: "P-001" });
  const r3 = reqIntake(db, root, { type: "requirement", title: "顺带构建", acceptance: ["npm build :: exit==0"] });
  reqApprove(db, root, { requirementId: r3.id, pathId: "P-001" });
  const r = cli(root, "task", "create", "--req", r2.id, "--path", "P-001", "--title", "对不上", "--scope", "src", "--accept", "npm build :: exit==0");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(deriveOf(root, "对不上"), [0]);
});

test("task list 列不粘连：abandoned 后面还有空格", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = taskCreate(db, root, {
    requirementId: reqId,
    pathId: "P-001",
    kind: "feature",
    title: "会被放弃的",
    scope: ["src"],
    acceptance: [{ deriveFrom: 0, assertion: "npm test :: exit==0" }],
  });
  db.prepare("UPDATE tasks SET status='abandoned' WHERE id=?").run(t.id);

  const out = cli(root, "task", "list").stdout;
  const line = out.split("\n").find((l) => l.startsWith(t.id));
  assert.match(line, /abandoned\s+\w+/, `状态和类型之间要有空格：${JSON.stringify(line)}`);
});
