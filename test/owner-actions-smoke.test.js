// devcontrol — 每个 Owner 动作都得能"体面地失败"
//
// 真实事故：新加的 task.rank 在 console 里按 (db, root, payload) 调用，
// 但它的签名是 (db, input) —— 于是 root 被当成了参数对象，
// 一路传到 SQLite 变成 "ERR_INVALID_ARG_TYPE: Provided value cannot be bound"。
// 用户看到的是这句 SQLite 内部错误，完全不知道是自己点错了还是内核坏了。
//
// 所以：随便传个空参数进去，每个动作都必须报一个**领域错误**（NOT_FOUND / E_CONTRACT…），
// 而不是把底层异常（签名错、绑定错、undefined）漏给调用方。
import test from "node:test";
import assert from "node:assert/strict";
import { makeRepo, initFlow } from "./helpers.js";
import { OWNER_ACTIONS } from "../src/console.js";

const DOMAIN = /^(NOT_FOUND|E_[A-Z_]+|INVALID_ARGUMENT)$/;

test("每个 Owner 动作在空参数下只报领域错误，不漏底层异常", async () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  const leaks = [];

  for (const [name, fn] of Object.entries(OWNER_ACTIONS)) {
    try {
      await fn(db, root, {});
    } catch (e) {
      const code = String(e.code ?? "");
      if (!DOMAIN.test(code)) leaks.push(`${name}: ${code || "(无 code)"} — ${String(e.message).slice(0, 80)}`);
    }
    // 不抛也不行：空参数不该"成功"
  }

  assert.deepEqual(leaks, [], `这些动作把底层异常漏出来了：\n${leaks.join("\n")}`);
});

test("每个 Owner 动作都是函数（注册了没实现只是空壳）", () => {
  for (const [name, fn] of Object.entries(OWNER_ACTIONS)) {
    assert.equal(typeof fn, "function", `${name} 不是函数`);
  }
});

test("task.rank 走 console 的真实签名（(db, root, payload)）也能用", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const { taskCreate } = await import("../src/gates.js");
  const t = taskCreate(db, root, {
    requirementId: reqId, pathId: "P-001", kind: "feature", title: "排一下",
    scope: ["src"], acceptance: [{ deriveFrom: 0, assertion: "npm test :: exit==0" }],
  });
  const res = await OWNER_ACTIONS["task.rank"](db, root, { taskId: t.id, mode: "top" });
  assert.equal(typeof res.rank, "number");
  assert.equal(db.prepare("SELECT rank FROM tasks WHERE id=?").get(t.id).rank, res.rank);
});
