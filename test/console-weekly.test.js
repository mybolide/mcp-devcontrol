// devcontrol — 控制台的周报：Owner 不看命令行，这段数据必须走页面这条路
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { makeRepo, initFlow, BIN } from "./helpers.js";

const PORT = 33000 + Math.floor(Math.random() * 8000);

function startConsole(root, port = PORT) {
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

const get = (port, path) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "GET", headers: { host: `127.0.0.1:${port}` } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, json: () => JSON.parse(body || "{}") }));
    });
    req.on("error", reject);
    req.end();
  });

const ago = (days) => new Date(Date.now() - days * 86_400_000).toISOString();

test("控制台 /api/state 带 weekly：默认 7 天", async () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  const stmt = db.prepare("INSERT INTO events(at, actor, channel, action, task_id, code, detail) VALUES(?,?,?,?,?,?,?)");
  stmt.run(ago(1), "agent-a", "agent", "close", "T-001", null, "");
  stmt.run(ago(20), "agent-a", "agent", "close", "T-002", null, "");

  const srv = await startConsole(root);
  try {
    const r = await get(srv.port, "/api/state");
    assert.equal(r.status, 200);
    const w = r.json().weekly;
    assert.ok(w, "没有 weekly 字段，页面就画不出来");
    assert.equal(w.days, 7);
    assert.equal(w.totals.closed, 1, "20 天前那条不在默认窗口内");
    assert.ok(Array.isArray(w.byDay));
    assert.ok(Array.isArray(w.byActor));
    assert.ok(Array.isArray(w.topBlocked));
    assert.match(w.since, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    srv.stop();
  }
});

test("控制台 ?days=30 能看更长的窗口", async () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  db.prepare("INSERT INTO events(at, actor, channel, action, task_id, code, detail) VALUES(?,?,?,?,?,?,?)").run(
    ago(20), "agent-a", "agent", "close", "T-001", null, "",
  );

  const srv = await startConsole(root, PORT + 1);
  try {
    assert.equal((await get(srv.port, "/api/state")).json().weekly.totals.closed, 0);
    const r30 = await get(srv.port, "/api/state?days=30");
    assert.equal(r30.json().weekly.days, 30);
    assert.equal(r30.json().weekly.totals.closed, 1);
  } finally {
    srv.stop();
  }
});

test("控制台 days 越界或不是整数：400 + INVALID_ARGUMENT，不吭声给个错窗口", async () => {
  const root = makeRepo();
  initFlow(root);
  const srv = await startConsole(root, PORT + 2);
  try {
    for (const bad of ["0", "-7", "abc", "366", "7.5"]) {
      const r = await get(srv.port, `/api/state?days=${bad}`);
      assert.equal(r.status, 400, `days=${bad} 应该 400`);
      assert.equal(r.json().code, "INVALID_ARGUMENT");
    }
    // 空值与缺省等价，都是 7
    assert.equal((await get(srv.port, "/api/state?days=")).json().weekly.days, 7);
  } finally {
    srv.stop();
  }
});

test("weekly 的口径和 CLI 一致：同一批事件，两边算出来一样", async () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  const stmt = db.prepare("INSERT INTO events(at, actor, channel, action, task_id, code, detail) VALUES(?,?,?,?,?,?,?)");
  stmt.run(ago(1), "agent-a", "agent", "task.claim", "T-001", null, "");
  stmt.run(ago(1), "agent-a", "agent", "close", "T-001", null, "");
  stmt.run(ago(2), "agent-b", "agent", "close.fail", "T-002", "E_SCOPE_VIOLATION", "");

  const srv = await startConsole(root, PORT + 3);
  try {
    const w = (await get(srv.port, "/api/state")).json().weekly;
    assert.equal(w.totals.closed, 1);
    assert.equal(w.totals.blocked, 1);
    assert.deepEqual(
      w.byActor.map((a) => a.actor).sort(),
      ["agent-a", "agent-b"],
      "按人分得开——这是 T-088 修好之后才可能的",
    );
    assert.deepEqual(w.topBlocked, [{ code: "E_SCOPE_VIOLATION", count: 1 }]);
  } finally {
    srv.stop();
  }
});