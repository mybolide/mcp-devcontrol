// release plan 的任务号写法：「人怎么打都行，别让人猜格式」。
//
// 起因是真实踩坑：`devcontrol release plan R-004 --tasks T-108,T-109`
// 把逗号串整段当成一个编号，只回一句「任务不存在：T-108,T-109」，
// 人看了只会怀疑自己任务号记错了，而不会想到是分隔符的问题。
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { BIN, initFlow, makeRepo, newTask } from "./helpers.js";
import { createRelease, planRelease } from "../src/release.js";

const run = (cwd, args) => {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
};

// 一个够用的最小仓库：git 仓库 + 已批准需求 + 两个任务（直接标 done）+ 一个空发布
const setup = () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const a = newTask(db, root, reqId, { title: "a" });
  const b = newTask(db, root, reqId, { title: "b" });
  db.prepare("UPDATE tasks SET status='done', closed_by='evidence', closed_at=datetime('now')").run();
  const rel = run(root, ["release", "create", "v0"]);
  assert.equal(rel.code, 0, rel.stderr);
  return { root, db, ids: [a.id, b.id], releaseId: JSON.parse(rel.stdout).id };
};

test("planRelease：逗号串在 CLI 侧被拆开，而不是当成一个编号", () => {
  const { root } = setup();
  const out = run(root, ["release", "plan", "R-001", "--tasks", "T-001,T-002"]);
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout).tasks.map((t) => t.id).sort(), ["T-001", "T-002"]);
});

test("planRelease：有编号不存在时，报错里带上真实存在的编号（而不是只说找不到）", () => {
  const { root, db, releaseId } = setup();
  assert.throws(
    () => planRelease(db, { id: releaseId, tasks: ["T-999"] }),
    (e) => {
      assert.equal(e.code, "NOT_FOUND");
      assert.deepEqual(e.data?.missing, ["T-999"], "得说清哪个号不对");
      assert.ok(e.data?.known?.includes("T-001"), "得把人能用的编号摆出来，否则只能回去翻");
      assert.match(e.data?.hint ?? "", /release plan/, "还要给一条能直接抄的命令");
      return true;
    },
  );
  void root;
});

test("CLI 三种写法等价：--tasks 逗号串 / --tasks 出现两次 / 一个 --tasks 里空格分隔", () => {
  for (const args of [
    ["--tasks", "T-001,T-002"],
    ["--tasks", "T-001", "--tasks", "T-002"],
    ["--tasks", "T-001 T-002"],
  ]) {
    const { root } = setup();
    const out = run(root, ["release", "plan", "R-001", ...args]);
    assert.equal(out.code, 0, `${args.join(" ")} 应该能过：${out.stderr}`);
    assert.deepEqual(JSON.parse(out.stdout).tasks.map((t) => t.id).sort(), ["T-001", "T-002"], `写法 ${args.join(" ")} 没解析对`);
  }
});

test("CLI 位置参数写法（README 里那条）照样能用", () => {
  const { root } = setup();
  const out = run(root, ["release", "plan", "R-001", "T-001", "T-002"]);
  assert.equal(out.code, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).tasks.length, 2);
});

test("一个任务号都不给：说清怎么写，而不是静默什么都不做", () => {
  const { root } = setup();
  const out = run(root, ["release", "plan", "R-001", "--tasks", ""]);
  assert.equal(out.code, 2, "用法错该是退出码 2");
  assert.match(out.stderr, /release plan/, "提示里要有正确的命令形状");
});

test("具体 hint 优先于按错误码的通用提示（stderr 上也一样）", () => {
  const { root } = setup();
  const out = run(root, ["release", "plan", "R-001", "--tasks", "T-999"]);
  assert.notEqual(out.code, 0);
  assert.match(out.stderr, /T-001/, "stderr 是给人看的那一行，真实编号得出现在这里");
  assert.match(JSON.parse(out.stdout).hint, /release plan/);
});

test("空发布 plan 仍然拒绝（别为了好看放松门禁）", () => {
  const { db } = setup();
  const empty = createRelease(db, { title: "空的" });
  assert.throws(() => planRelease(db, { id: empty.id, tasks: [] }), (e) => e.code === "E_CONTRACT");
});

// src/release.js 是 ESM，测试体里要 await import；抽出来免得每处都写
let mod;
function awaitImport() {
  return mod;
}
mod = await import("../src/release.js");