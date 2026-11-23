// devcontrol — 收口要让人看得见在跑什么
//
// 一次收口要核对证据指纹和提交链（大仓库上也要一两秒）。以前这段时间里
// 一个输出都没有，看着像卡死，人会 Ctrl-C —— 那就等于白跑一遍。
// 约束：进度只走回调（CLI → stderr），stdout 必须始终是能整段 JSON.parse 的结果。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getTask } from "../src/store.js";
import { taskClaim, taskClose } from "../src/gates.js";
import { commitFiles } from "../src/git.js";
import { makeRepo, initFlow, newTask, prove, BIN, sh, closeProven } from "./helpers.js";
import { execFileSync } from "node:child_process";

const ready = (db, root, task) => {
  taskClaim(db, root, { id: task.id }, "agent");
  fs.writeFileSync(path.join(root, "src/a.js"), `export const a = "${task.id}";\n`);
  commitFiles(root, ["src/a.js"], `feat\n\nTask-Id: ${task.id}`, { author: "agent" });
  return task;
};

test("taskClose 会上报阶段：准备 → 检查 → 跑验收 → 完成", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = ready(db, root, newTask(db, root, reqId));

  const seen = [];
  const res = await closeProven(db, root, { id: t.id }, { onProgress: (e) => seen.push(e) });
  assert.equal(res.closedBy, "evidence");

  const stages = seen.map((e) => e.stage);
  for (const want of ["start", "checks", "evidence", "evidence-done", "done"]) {
    assert.ok(stages.includes(want), `缺少阶段 ${want}（实际 ${stages.join(",")}）`);
  }
  // 每条事件都带耗时，最后一条的总耗时应当 ≥ 第一条
  const first = seen.find((e) => e.stage === "start");
  const last = seen.find((e) => e.stage === "done");
  assert.ok(Number.isFinite(first.elapsedMs));
  assert.ok(last.elapsedMs >= first.elapsedMs);
  assert.match(last.detail, /收口完成/);
});

test("验收失败时上报的是失败阶段，并且带上错误码", async () => {
  const root = makeRepo({ failTest: true });
  const { db, reqId } = initFlow(root);
  const t = ready(db, root, newTask(db, root, reqId));

  const seen = [];
  await assert.rejects(
    () => prove(db, root, t.id, { exit: 1 }).length && taskClose(db, root, { id: t.id }, { onProgress: (e) => seen.push(e) }),
    (e) => e.code === "E_ASSERTION_FAILED",
  );
  const failed = seen.find((e) => e.stage === "failed");
  assert.ok(failed, "失败必须报一句，否则不知道停在哪一步");
  assert.match(failed.detail, /E_ASSERTION_FAILED/);
});

test("进度回调自己抛错不能把收口带崩", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = ready(db, root, newTask(db, root, reqId));

  const res = await closeProven(db, root, { id: t.id }, {
    onProgress: () => {
      throw new Error("进度上报炸了");
    },
  });
  assert.equal(getTask(db, t.id).status, "done", "进度只是观测，不能影响收口结果");
  assert.equal(res.closedBy, "evidence");
});

test("CLI close：进度写 stderr，stdout 仍是一整段可解析的 JSON", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = ready(db, root, newTask(db, root, reqId));

  prove(db, root, t.id);
  const out = execFileSync(
    process.execPath,
    [BIN, "close", t.id, "--summary", "夹具结论", "--changes", "夹具改动", "--limitations", "无"],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.closedBy, "evidence");
  assert.ok(sh(root, "git", "log", "-1", "--pretty=%s").length > 0);
});