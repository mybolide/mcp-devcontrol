// devcontrol — 控制台周报视图：接线对不对，看源码文本；口径对不对，真起服务看返回
//
// 前半段（入口 + 骨架）是另一个人做的，这里连"接上了没"一起验。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import http from "node:http";
import { makeRepo, initFlow, BIN } from "./helpers.js";

const HTML = fs.readFileSync(path.join(import.meta.dirname, "..", "public", "index.html"), "utf8");

const PORT = 41000 + Math.floor(Math.random() * 8000);

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

const getJson = (port, path) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "GET", headers: { host: `127.0.0.1:${port}` } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve(JSON.parse(body || "{}")));
    });
    req.on("error", reject);
    req.end();
  });

test("侧栏有周报入口，点得进去（导航与视图两边都在）", () => {
  assert.match(HTML, /data-nav="weekly"/, "侧栏没有入口");
  assert.match(HTML, /data-view="weekly"/, "没有对应视图，点了会白屏");
  assert.match(HTML, /VIEWS\s*=\s*\{[^}]*weekly:\s*"周报"/, "标题表里没有 weekly，面包屑会显示英文");
});

test("视图里有容器，渲染函数找得到它", () => {
  assert.match(HTML, /id="weekly-panel"/);
  assert.match(HTML, /function renderWeeklyPanel\s*\(s\)/);
  assert.match(HTML, /\$\("weekly-panel"\)/, "渲染函数没去拿容器");
});

test("渲染函数被主流程调用（否则数据到了也不画）", () => {
  const tick = HTML.slice(HTML.indexOf("renderMetrics(s.digest)"));
  const body = tick.slice(0, tick.indexOf("restoreFocus"));
  assert.match(body, /renderWeeklyPanel\(s\)/, "主流程漏了这一步，等于没做");
});

test("三张表都在：按天、按人、拦在哪", () => {
  const fn = HTML.slice(HTML.indexOf("function renderWeeklyPanel"));
  const body = fn.slice(0, fn.indexOf("function renderDocs"));
  for (const head of ["日期", "新建", "领取", "收口", "被拦", "放行", "谁", "主要拦在哪"]) {
    assert.ok(body.includes(head), `少了一列：${head}`);
  }
  assert.match(body, /byDay/, "没读 byDay");
  assert.match(body, /byActor/, "没读 byActor");
  assert.match(body, /topBlocked/, "没读 topBlocked");
});

test("前端不自己算成率：结论句用后端给的 verdict", () => {
  const fn = HTML.slice(HTML.indexOf("function renderWeeklyPanel"));
  const body = fn.slice(0, fn.indexOf("function renderDocs"));
  assert.match(body, /w\.verdict/, "结论句没用后端的，就是两套口径");
  assert.doesNotMatch(body, /closed\s*\/\s*t\.?claimed|\*\s*100/, "前端自己算成率 = 口径漂移");
});

test("空数据也要有话说，不留空白页", () => {
  const fn = HTML.slice(HTML.indexOf("function renderWeeklyPanel"));
  const body = fn.slice(0, fn.indexOf("function renderDocs"));
  assert.match(body, /这周一条事件都没有/);
  assert.match(body, /这周没人领活/);
  assert.match(body, /这周没被拦过/);
});

test("后端把结论句一起给：verdict 与 CLI 同源", async () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  db.prepare("INSERT INTO events(at, actor, channel, action, task_id, code, detail) VALUES(?,?,?,?,?,?,?)").run(
    new Date().toISOString(), "agent-a", "agent", "close", "T-001", null, "",
  );

  const srv = await startConsole(root);
  try {
    const w = (await getJson(srv.port, "/api/state")).weekly;
    assert.ok(w.verdict, "没有 verdict，前端只能自己编一句话");
    assert.match(w.verdict, /收口 1 条/);
  } finally {
    srv.stop();
  }
});