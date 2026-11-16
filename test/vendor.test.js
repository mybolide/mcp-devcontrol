// devcontrol — 全栈项目的两条底线：依赖与构建产物不进仓库，也不堵住 commit
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { makeRepo, BIN } from "./helpers.js";
import { openDb } from "../src/db.js";
import { reqIntake, reqApprove } from "../src/store.js";
import { taskClaim, taskClose, taskCreate } from "../src/gates.js";
import { isVendorDir, isVendorPath } from "../src/vendor.js";

const sh = (cwd, ...args) => spawnSync(args[0], args.slice(1), { cwd, encoding: "utf8" }).stdout?.trim() ?? "";
const write = (root, rel, body) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
};
const tracked = (root) => sh(root, "git", "ls-files").split("\n").filter(Boolean);
/** init 已经建好 P-001（allowed="."，draft）：走一遍正常的「提需求 → 批准 → 建任务」 */
function flow(root, { scope, testCmd = "npm test" }) {
  const db = openDb(root);
  db.prepare("UPDATE paths SET test_cmds_json=? WHERE id='P-001'").run(JSON.stringify([testCmd]));
  const req = reqIntake(db, root, { type: "requirement", title: "r", goal: "g", acceptance: [`${testCmd} :: exit==0`] });
  reqApprove(db, root, { requirementId: req.id, pathId: "P-001" });
  const task = taskCreate(db, root, {
    requirementId: req.id,
    pathId: "P-001",
    kind: "feature",
    title: "改代码",
    acceptance: [{ deriveFrom: 0, assertion: `${testCmd} :: exit==0` }],
    scope,
  });
  return { db, task };
}

/** 把依赖/构建产物的忽略行删掉：模拟「项目自己的 .gitignore 没写全」，
 *  这样才能验证内核自己的防护，而不是靠 .gitignore 蒙过去 */
function dropVendorIgnores(root) {
  const abs = path.join(root, ".gitignore");
  const kept = fs
    .readFileSync(abs, "utf8")
    .split("\n")
    .filter((l) => !["node_modules/", "dist/", "build/", "coverage/", "__pycache__/", ".venv/", "target/"].includes(l.trim()));
  fs.writeFileSync(abs, kept.join("\n"), "utf8");
  // 改完 .gitignore 要提交，否则它会以「scope 外的改动」身份干扰后面的断言
  sh(root, "git", "add", ".gitignore");
  sh(root, "git", "commit", "-qm", "chore: 模拟项目自己没写全的 .gitignore");
}

const dc = (root, ...args) => {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: root,
    env: { ...process.env, DEVCONTROL_ROOT: root, DEVCONTROL_ACTOR: "a1", DEVCONTROL_MEMORY: "off" },
    encoding: "utf8",
  });
  return { code: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
};

test("isVendorDir：认得出各生态的依赖与构建产物，但不误伤真源码目录", () => {
  for (const d of ["node_modules", "node_modules/x/y", "packages/web/node_modules", "dist", "packages/web/dist", "coverage", "__pycache__", ".venv", "target", ".next"]) {
    assert.equal(isVendorDir(d), true, `${d} 应算依赖/构建产物`);
  }
  // 这些是真源码，不能被误判
  for (const d of ["src", "src/build", "lib/dist-utils", "server", "web", "shared", "src/app"]) {
    assert.equal(isVendorDir(d), false, `${d} 不该算依赖/构建产物`);
  }
  assert.equal(isVendorPath("node_modules/a/index.js"), true);
  assert.equal(isVendorPath("dist/app.js"), true);
  assert.equal(isVendorPath("src/app.js"), false, "普通源码不是产物");
  assert.equal(isVendorPath("src/build.js"), false, "文件名带 build 不算目录");
});

test("init 生成的 .gitignore 含依赖与构建产物（新项目不用自己想起这件事）", () => {
  const root = makeRepo();
  dc(root, "init", "--no-mcp");
  const gi = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  for (const entry of ["node_modules/", "dist/", "coverage/"]) {
    assert.match(gi, new RegExp(`^${entry.replace("/", "\\/")}$`, "m"), `.gitignore 应含 ${entry}`);
  }
});

test("scope 写成 \".\"：装完依赖再 commit，node_modules 不会被提交进仓库", () => {
  const root = makeRepo();
  dc(root, "init", "--no-mcp");
  dropVendorIgnores(root); // 模拟项目没写 .gitignore：只能靠内核自己拦
  const { db, task: t } = flow(root, { scope: ["."] });
  db.close();
  dc(root, "task", "claim", t.id);

  // init 之后才装依赖（真实顺序）；node_modules 是未跟踪目录
  write(root, "node_modules/dep-a/index.js", "export default 1;\n");
  write(root, "src/stats.js", "export const total = (xs) => xs.reduce((a, b) => a + b, 0);\n");

  const c = dc(root, "commit", "-m", "feat: 加统计");
  assert.equal(c.code, 0, `commit 应该成功：${c.err}`);

  const files = sh(root, "git", "show", "--name-only", "--pretty=format:", "HEAD").split("\n").filter(Boolean);
  assert.ok(files.includes("src/stats.js"), "真实改动要进提交");
  assert.equal(files.some((f) => f.startsWith("node_modules/")), false, "依赖不能进仓库");
  assert.equal(tracked(root).some((f) => f.startsWith("node_modules/")), false, "仓库里不该出现依赖文件");
});

test("scope 写成 \"src\"：装完依赖不会把 commit 永久堵死（依赖不算 scope 违规）", () => {
  const root = makeRepo();
  dc(root, "init", "--no-mcp");
  dropVendorIgnores(root); // 同上：.gitignore 里没有 node_modules
  const { db, task: t } = flow(root, { scope: ["src"] });
  db.close();
  dc(root, "task", "claim", t.id);

  write(root, "node_modules/dep-a/index.js", "export default 1;\n");
  write(root, "src/a.js", "export const a = 2;\n");

  const c = dc(root, "commit", "-m", "fix: a=2");
  assert.equal(c.code, 0, `依赖在 scope 外也不该拦住 commit：${c.err}`);
  assert.match(c.err, /跳过 \d+ 个依赖/, "要告诉人跳过了什么，而不是默默忽略");
});

test("被 git 跟踪的 dist/ 照常参与提交：内核不翻案", () => {
  const root = makeRepo();
  // 有人特意把 dist 提交进了仓库
  write(root, "dist/app.js", "/* v1 */\n");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-qm", "chore: 提交构建产物");
  dc(root, "init", "--no-mcp");
  const { db, task: t } = flow(root, { scope: ["dist", "src"] });
  db.close();
  dc(root, "task", "claim", t.id);

  write(root, "dist/app.js", "/* v2 */\n");
  const c = dc(root, "commit", "-m", "chore: 更新构建产物");
  assert.equal(c.code, 0, `已跟踪的 dist 应该能正常提交：${c.err}`);
  const files = sh(root, "git", "show", "--name-only", "--pretty=format:", "HEAD").split("\n").filter(Boolean);
  assert.ok(files.includes("dist/app.js"), "已跟踪的产物要能提交");
});

test("依赖/构建产物不会拦住收口（装依赖、跑构建是开发常态）", async () => {
  const root = makeRepo();
  dc(root, "init", "--no-mcp");
  dropVendorIgnores(root); // 收口时的脏树判定也不能靠 .gitignore
  const { db, task: t } = flow(root, { scope: ["src"] });
  taskClaim(db, root, { id: t.id }, "a1");
  db.close();

  write(root, "src/a.js", "export const a = 2;\n");
  const c = dc(root, "commit", "-m", "fix: a=2");
  assert.equal(c.code, 0, c.err);

  // 收口前顺手跑了构建 + 装了依赖
  write(root, "dist/app.js", "/* built */\n");
  write(root, "node_modules/dep-b/index.js", "export default 2;\n");

  const db2 = (await import("../src/db.js")).openDb(root);
  const r = await taskClose(db2, root, { id: t.id });
  db2.close();
  assert.equal(r.id, t.id, "依赖与构建产物不该让收口失败");
  assert.ok(r.runs.length > 0 && r.runs.every((x) => x.passed), "验收要真的跑过并且通过");
});
