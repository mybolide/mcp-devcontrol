// devcontrol — doctor 的两类误报（真实项目报出来的）
//
// ① allowed_paths 支持 glob（`dir/**`），早先直接拿去 existsSync，于是所有这种写法
//    都被报成「路径不存在」；
// ② Path 是**可复用**的：一条 Path 被重新批准给别的需求后，源需求就没有自己的 Path 了。
//    需求要是已经做完，这是历史而不是待办，报成 error 只会让人开始无视 doctor。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { doctor } from "../src/report.js";
import { makeRepo, initFlow, newTask } from "./helpers.js";

function addPath(db, { id = "P-900", requirementId = "FR-001", allowed, cmds = ["npm test"], status = "draft" } = {}) {
  db.prepare(
    "INSERT INTO paths(id,requirement_id,allowed_paths_json,allow_new_files,budget_lines,test_cmds_json,status) VALUES(?,?,?,0,1200,?,?)",
  ).run(id, requirementId, JSON.stringify(allowed), JSON.stringify(cmds), status);
}

test("dir/** 是 glob，不是不存在的文件（不再误报 STALE_PATH）", () => {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, "docs/spikes"), { recursive: true });
  const { db } = initFlow(root);
  addPath(db, { allowed: ["docs/spikes/**"] });
  const stale = doctor(db, root).filter((i) => i.code === "STALE_PATH");
  assert.deepEqual(stale, [], `docs/spikes/** 存在，不该报：${JSON.stringify(stale)}`);
  db.close();
});

test("真不存在的路径照样要报（别把检查修成摆设）", () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  addPath(db, { allowed: ["docs/nope/**"] });
  const stale = doctor(db, root).filter((i) => i.code === "STALE_PATH");
  assert.equal(stale.length, 1);
  assert.match(stale[0].detail, /docs\/nope/);
  db.close();
});

test("需求已做完、Path 被复用：note 而不是 error", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  // 需求多一条验收，却没有 Path 冻结它
  db.prepare("UPDATE requirements SET acceptance_json=? WHERE id=?").run(
    JSON.stringify(["npm test :: exit==0", "npm run build :: exit==0"]),
    reqId,
  );
  const task = newTask(db, root, reqId);
  // 任务把两条验收都认领了，而且已经做完
  db.prepare("UPDATE tasks SET status='done', acceptance_json=? WHERE id=?").run(
    JSON.stringify([
      { deriveFrom: 0, assertion: "npm test :: exit==0" },
      { deriveFrom: 1, assertion: "npm run build :: exit==0" },
    ]),
    task.id,
  );
  const items = doctor(db, root).filter((i) => ["ACCEPTANCE_NOT_IN_CONTRACT", "ACCEPTANCE_PATH_MOVED"].includes(i.code));
  assert.equal(items.length, 1, JSON.stringify(items));
  assert.equal(items[0].code, "ACCEPTANCE_PATH_MOVED");
  assert.equal(items[0].severity, "note");
  assert.match(items[0].detail, /复用/);
  db.close();
});

test("需求还有没做完的活时，仍然是 error（真问题不能被降级）", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  db.prepare("UPDATE requirements SET acceptance_json=? WHERE id=?").run(
    JSON.stringify(["npm test :: exit==0", "npm run build :: exit==0"]),
    reqId,
  );
  const task = newTask(db, root, reqId); // backlog：还没做完
  db.prepare("UPDATE tasks SET acceptance_json=? WHERE id=?").run(
    JSON.stringify([
      { deriveFrom: 0, assertion: "npm test :: exit==0" },
      { deriveFrom: 1, assertion: "npm run build :: exit==0" },
    ]),
    task.id,
  );
  const items = doctor(db, root).filter((i) => i.code === "ACCEPTANCE_NOT_IN_CONTRACT");
  assert.equal(items.length, 1);
  assert.equal(items[0].severity, "error");
  db.close();
});