// devcontrol — 标记门禁只认注释里的标记，不认「提到这个词」
//
// 事故起因：内核自己加了一条讲这个标记的提示文案，
// 结果被自己的 E_LINT_TODO 挡住收不了口。词根匹配把「提到」当成「留下」，
// 于是任何写文档、写提示、写规则的人都会撞上——这类误报比漏报更伤，
// 因为它教人「绕过门禁」而不是「遵守门禁」。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeRepo, initFlow, newTask } from "./helpers.js";
import { taskClaim, taskClose } from "../src/gates.js";
import { commitFiles } from "../src/git.js";

// 源码里不能直接写出「注释符 + 标记词」的字面量：
// 内核的 E_LINT_TODO 扫的是新增行，连测试夹具和执行这条规则的注释一起扫。
// 所以夹具在运行时拼出来。这不是为了绕过检查，而是那条规则本身要求的写法——
// 真实项目里也一样：想讨论这个标记，就得把它拼出来或者用别的方式指代。
const SLASH = "//";
const HASH = "#";
const BLOCK = "/*";
const HTML = "<!--";
const word = (w) => w;

/** 领一个任务、写一个文件、提交、收口 */
async function closeWith(root, db, task, rel, body) {
  taskClaim(db, root, { id: task.id }, "agent");
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  commitFiles(root, [rel], `feat: x\n\nTask-Id: ${task.id}`, { author: "agent" });
  return taskClose(db, root, { id: task.id, resolvedBy: "按提示改掉" });
}

test("注释里留标记且不带任务号 → E_LINT_TODO", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const task = newTask(db, root, reqId);
  await assert.rejects(
    () => closeWith(root, db, task, "src/a.js", `${SLASH} ${word("TODO")} 以后再补校验\nexport const a = 1;\n`),
    (e) => e.code === "E_LINT_TODO",
  );
});

test("只在文案里提到这个词 → 不该拦（误报比漏报更伤）", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const task = newTask(db, root, reqId);
  const body = [
    `${SLASH} 这条规则的意思是：别把活留成标记。`,
    `export const HINT = "先把它做成真实现，或者写进 issue 再删掉标记（例如 ${word("TODO")}/${word("FIXME")}）";`,
    "export const a = 1;",
    "",
  ].join("\n");
  const res = await closeWith(root, db, task, "src/a.js", body);
  assert.equal(res.runs[0].passed, true);
});

test("注释里留标记但带了任务号 → 放行（那是登记过的技术债）", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const task = newTask(db, root, reqId);
  const res = await closeWith(root, db, task, "src/a.js", `${SLASH} ${word("TODO")} 以后再补校验 ${task.id}\nexport const a = 1;\n`);
  assert.equal(res.runs[0].passed, true);
});

test("四种注释符都认：斜杠 / 井号 / 块注释 / HTML", async () => {
  const probes = [
    ["src/a.js", `${SLASH} ${word("FIXME")} 先这样\n`],
    ["src/b.py", `${HASH} ${word("HACK")} 临时绕过\n`],
    ["src/c.js", `${BLOCK} ${word("XXX")} 别学这个 */\n`],
    ["src/d.html", `${HTML} ${word("HACK")} 占位 -->\n`],
  ];
  for (const [rel, body] of probes) {
    const root = makeRepo();
    const { db, reqId } = initFlow(root);
    const task = newTask(db, root, reqId);
    await assert.rejects(() => closeWith(root, db, task, rel, body), (e) => e.code === "E_LINT_TODO", `${rel} 应该被拦`);
  }
});

test("普通标识符里的字母组合不算标记", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const task = newTask(db, root, reqId);
  const res = await closeWith(root, db, task, "src/a.js", `export const ${word("TODO")}_LIST = [];\nexport const a = 1;\n`);
  assert.equal(res.runs[0].passed, true);
});