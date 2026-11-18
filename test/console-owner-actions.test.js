// 控制台的 owner action 白名单只能认「自有键」。
//
// 起因是真实踩坑：POST /api/owner {"action":"constructor"} 回了 200 且 ok:true，
// 还把 sqlite 句柄的内部属性（isOpen、limits…）吐给了调用方。原因是
// OWNER_ACTIONS[payload.action] 会沿原型链取值，constructor / toString /
// hasOwnProperty 这些统统「命中」。本地控制台本来就不设门，但白名单本身必须是白名单，
// 否则「未知动作」这条防线等于不存在。
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { makeRepo, initFlow, newTask, BIN } from "./helpers.js";

function startConsole(root, port) {
  const child = spawn(process.execPath, [BIN, "serve", "--port", String(port), "--host", "127.0.0.1"], {
    cwd: root,
    env: { ...process.env, DEVCONTROL_ROOT: root, DEVCONTROL_OWNER_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`serve 未就绪：${out}`)), 15000);
    const onData = (d) => {
      out += d.toString();
      if (out.includes("项目：")) {
        clearTimeout(timer);
        resolve({ port, stop: () => child.kill() });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`serve 退出 ${code}：${out}`));
    });
  });
}

function post(port, path, body) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          host: `127.0.0.1:${port}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode, text, json: () => JSON.parse(text || "{}") }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

async function withConsole(fn) {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  // 造一条真实存在的任务：adjust 要调整的是它，不是凭空一个编号。
  newTask(db, root, reqId, { title: "改 a.js", scope: ["src/a.js"] });
  const port = 43000 + Math.floor(Math.random() * 8000);
  const srv = await startConsole(root, port);
  try {
    await fn(port);
  } finally {
    srv.stop();
  }
}

test("action=constructor 不是合法动作：400，且不吐库句柄内部属性", async () => {
  await withConsole(async (port) => {
    const res = await post(port, "/api/owner", { action: "constructor", payload: {} });
    assert.equal(res.status, 400, `应当是 400，实际 ${res.status}：${res.text}`);
    const body = res.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, "INVALID_ARGUMENT");
    assert.match(body.message, /未知 owner action/);
    // 别把数据库句柄的内部属性当成结果回给调用方
    assert.ok(!("result" in body), "不该有 result");
    assert.ok(!res.text.includes("isTransaction"), "不该吐 sqlite 句柄内部字段");
  });
});

test("原型链上的其它名字也一律不认：toString / hasOwnProperty / valueOf", async () => {
  await withConsole(async (port) => {
    for (const name of ["toString", "hasOwnProperty", "valueOf", "isPrototypeOf", "__proto__"]) {
      const res = await post(port, "/api/owner", { action: name, payload: {} });
      assert.equal(res.status, 400, `action=${name} 应当是 400，实际 ${res.status}：${res.text}`);
      assert.equal(res.json().code, "INVALID_ARGUMENT", `action=${name} 不该被当成合法动作`);
    }
  });
});

test("body 不是 JSON：400 + INVALID_ARGUMENT，不是 E_INTERNAL", async () => {
  await withConsole(async (port) => {
    const res = await post(port, "/api/owner", "not-json");
    assert.equal(res.status, 400);
    const body = res.json();
    assert.equal(body.ok, false);
    // 用 E_INTERNAL 会把「内核故障」计数虚增，也会让人以为该上报 bug
    assert.equal(body.code, "INVALID_ARGUMENT", "打错格式不是内核崩了");
  });
});

test("真正的合法动作照样能用：adjust 仍然生效", async () => {
  await withConsole(async (port) => {
    const res = await post(port, "/api/owner", {
      action: "adjust",
      payload: {
        taskId: "T-001",
        scope: ["src/a.js", "src/b.js"],
        reason: "这条任务本来就该改两个文件",
      },
    });
    assert.equal(res.status, 200, res.text);
    const body = res.json();
    assert.equal(body.ok, true, `合法动作不该被挡住：${res.text}`);
    assert.ok(body.result, "要真的执行并给出结果，不是回个空壳");
  });
});

// T-125：JSON.parse 能吐出 null / 数组 / 字符串 / 数字，它们没有 .action。
// 早先直接读 payload.action 就是 TypeError → HTTP 500 E_INTERNAL，
// 等于把「body 写错了」记成「内核崩了」，与 T-123 自相矛盾。
test("payload 不是 JSON 对象：null / 数组 / 字符串 / 数字一律 400，不许崩 500", async () => {
  await withConsole(async (port) => {
    for (const raw of ["null", "[]", '"adjust"', "42", "true", "[{\"action\":\"adjust\"}]"]) {
      const res = await post(port, "/api/owner", raw);
      assert.equal(res.status, 400, `body=${raw} 应当是 400，实际 ${res.status}：${res.text}`);
      const body = res.json();
      assert.equal(body.ok, false, `body=${raw} 不该 ok`);
      // 内核故障计数（T-119）只该记真正的内核故障
      assert.equal(body.code, "INVALID_ARGUMENT", `body=${raw} 不该记成内核故障：${res.text}`);
      assert.match(body.message, /JSON 对象/);
    }
  });
});

test("空 body 当成 {}，报「未知 owner action」而不是 TypeError", async () => {
  await withConsole(async (port) => {
    const res = await post(port, "/api/owner", "");
    assert.equal(res.status, 400, res.text);
    assert.equal(res.json().code, "INVALID_ARGUMENT");
  });
});

// 413 那条：早先是先 req.destroy() 再 json(413)，连接已被 reset，客户端一句都收不到。
test("请求体超过 1MB：客户端真能收到 413，不是连接被 reset", async () => {
  await withConsole(async (port) => {
    const res = await post(port, "/api/owner", JSON.stringify({ action: "adjust", pad: "x".repeat(1_200_000) }));
    assert.equal(res.status, 413, `应当是 413，实际 ${res.status}：${res.text.slice(0, 200)}`);
    assert.equal(res.json().ok, false);
  });
});
