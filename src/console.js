// devcontrol — Owner 控制台（本地 web，127.0.0.1，Owner 动作只在这里）
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readConsoleMeta } from "./console-boot.js";
import { openDb } from "./db.js";
import { VERSION } from "./protocol.js";
import { bootstrap } from "./digest.js";
import {
  reqIntake,
  reqApprove,
  reqAmend,
  taskAdjust,
  taskReopen,
  bugDecide,
  answer,
  override,
  handoff,
  listTasks,
  listReqs,
  listPaths,
  listBugs,
  listDocs,
  listQuestions,
  listRuns,
} from "./store.js";
import { editMemory, listMemories, memoryConfig, promoteMemory, softDeleteMemory } from "./memory.js";
import { effectiveSettings, readSettings, settingsFile, writeSettings } from "./settings.js";
import { installAgentFiles } from "./skill.js";
import { resolveRoot } from "./cli.js";
import { sha256 } from "./fingerprint.js";
import { listReleases, shipRelease } from "./release.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, "..", "public");

const OWNER_ACTIONS = {
  intake: (db, root, p) => reqIntake(db, root, p),
  approve: (db, root, p) => reqApprove(db, root, p),
  amend: (db, root, p) => reqAmend(db, root, p),
  adjust: (db, root, p) => taskAdjust(db, root, p),
  reopen: (db, root, p) => taskReopen(db, p),
  decide: (db, root, p) => bugDecide(db, p),
  answer: (db, root, p) => answer(db, p),
  override: (db, root, p) => override(db, p),
  handoff: (db, root, p) => handoff(db, p),
  "memory.promote": async (db, root, p) => promoteMemory(memoryConfig(process.env, root), p.id),
  "memory.edit": async (db, root, p) => editMemory(memoryConfig(process.env, root), p.id, { title: p.title, body: p.body }, { promote: true }),
  "memory.drop": (db, root, p) => ({ dropped: softDeleteMemory(memoryConfig(process.env, root), p.id) }),
  "release.ship": (db, root, p) => shipRelease(db, { id: p.id }),
  "settings.save": (db, root, p) => writeSettings(root, p.settings ?? p),
};

export async function startConsole(args) {
  const root = resolveRoot();
  const portIdx = args.indexOf("--port");
  const port = Number(portIdx >= 0 ? args[portIdx + 1] : process.env.DEVCONTROL_PORT ?? 7373);
  if (args.includes("--stop")) {
    const meta = await readConsoleMeta(port);
    if (!meta) {
      console.log(`端口 ${port} 上没有 devcontrol 控制台`);
      return 1;
    }
    if (path.resolve(meta.root) !== path.resolve(root)) {
      console.log(`端口 ${port} 上是另一个项目的控制台（${meta.root}），不动它`);
      return 1;
    }
    try {
      process.kill(meta.pid, "SIGTERM");
    } catch {
      /* 已经退出 */
    }
    console.log(`已停止控制台（pid ${meta.pid}，端口 ${port}）`);
    return 0;
  }
  // 多项目：--project 可重复；第一个（或当前目录）是默认项目
  const extra = [];
  args.forEach((a, i) => {
    if (a === "--project") extra.push(args[i + 1]);
  });
  const roots = [...new Set([root, ...extra].filter(Boolean).map((r) => path.resolve(r)))];
  const projects = roots.map((r) => ({ root: r, name: path.basename(r) || r, db: openDb(r) }));

  // 控制台一启动就把 Agent 侧说明补/更新一遍：老项目 init 过也不会缺，版本升级自动跟上
  const refreshed = [];
  for (const p of projects) {
    for (const [rel, status] of Object.entries(installAgentFiles(p.root))) {
      if (status !== "unchanged") refreshed.push(`${rel}（${status === "created" ? "新建" : "更新"}）`);
    }
  }
  const byRoot = new Map(projects.map((p) => [p.root, p]));
  /** 显式指定了项目就必须命中；不指定才用默认项目（防止"以为切了、其实写到默认仓库"） */
  const pickProject = (wanted) => {
    const raw = String(wanted ?? "").trim();
    if (!raw) return projects[0];
    return byRoot.get(path.resolve(raw)) ?? null;
  };

  const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
  const token = process.env.DEVCONTROL_OWNER_TOKEN ?? null;
  /**
   * 本地控制台的访问闸门：
   * - Host 必须是回环地址（挡 DNS rebinding）
   * - 浏览器跨站请求一定带 Origin，且不等于本机来源 → 拒（挡 CSRF）
   * - POST 必须是 application/json（挡 no-cors 的 text/plain 简单请求）
   * - 若设置了 DEVCONTROL_OWNER_TOKEN，还要求请求头一致
   */
  const guard = (req) => {
    const host = String(req.headers.host ?? "");
    if (!LOOPBACK.test(host)) return { code: 403, body: { ok: false, code: "E_FORBIDDEN", message: "Host 不是回环地址" } };
    const origin = req.headers.origin;
    if (origin && !new RegExp(`^https?://(127\\.0\\.0\\.1|localhost|\\[::1\]):${port}$`).test(origin)) {
      return { code: 403, body: { ok: false, code: "E_FORBIDDEN", message: "跨站来源" } };
    }
    if (req.method === "POST" && !String(req.headers["content-type"] ?? "").includes("application/json")) {
      return { code: 415, body: { ok: false, code: "E_FORBIDDEN", message: "只接受 application/json" } };
    }
    if (token && req.headers["x-owner-token"] !== token) {
      return { code: 403, body: { ok: false, code: "E_FORBIDDEN", message: "缺少 X-Owner-Token" } };
    }
    return null;
  };
  const startedAt = new Date().toISOString();

  const handle = async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const json = (code, body) => {
      res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && url.pathname === "/") {
      const html = fs.readFileSync(path.join(PUBLIC, "index.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/meta") {
      // 用于「这个端口上是不是本项目的 devcontrol 控制台」的探测与复用
      return json(200, { app: "devcontrol", schema: 2, version: VERSION, root: projects[0].root, port, pid: process.pid, startedAt, projects: projects.map((p) => p.root) });
    }
    if (req.method === "GET" && url.pathname === "/api/settings") {
      const denied = guard(req);
      if (denied) return json(denied.code, denied.body);
      const active = pickProject(url.searchParams.get("project"));
      if (!active) return json(400, { ok: false, code: "INVALID_ARGUMENT", message: "未知 project" });
      return json(200, {
        root: active.root,
        file: settingsFile(active.root),
        saved: readSettings(active.root),
        effective: effectiveSettings(active.root),
      });
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      const denied = guard(req);
      if (denied) return json(denied.code, denied.body);
      const active = pickProject(url.searchParams.get("project"));
      if (!active) return json(400, { ok: false, code: "INVALID_ARGUMENT", message: "未知 project" });
      return json(200, {
        project: { root: active.root, name: active.name },
        projects: projects.map((p) => ({ name: p.name, root: p.root, current: p.root === active.root })),
        digest: bootstrap(active.db, active.root, { console: `http://127.0.0.1:${port}/` }),
        requirements: listReqs(active.db),
        paths: listPaths(active.db),
        tasks: listTasks(active.db),
        bugs: listBugs(active.db),
        docs: listDocs(active.db).map((d) => {
          const abs = path.join(active.root, d.path);
          const drift = !fs.existsSync(abs) ? "missing" : sha256(fs.readFileSync(abs)) !== d.sha256 ? "changed" : null;
          return { ...d, drift };
        }),
        questions: listQuestions(active.db),
        memories: listMemories(memoryConfig(process.env, active.root), 30, null, "candidate"),
        memoriesActive: listMemories(memoryConfig(process.env, active.root), 30, null, "active"),
        runs: listRuns(active.db, 30),
        releases: listReleases(active.db),
      });
    }
    if (req.method === "POST" && url.pathname === "/api/owner") {
      const denied = guard(req);
      if (denied) return json(denied.code, denied.body);
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1_000_000) {
          req.destroy();
          return json(413, { ok: false, code: "E_FORBIDDEN", message: "请求体过大" });
        }
      }
      let payload;
      try {
        payload = JSON.parse(body || "{}");
      } catch {
        return json(400, { ok: false, code: "E_INTERNAL", message: "body 不是 JSON" });
      }
      const action = OWNER_ACTIONS[payload.action];
      if (!action) return json(400, { ok: false, code: "INVALID_ARGUMENT", message: `未知 owner action：${payload.action}` });
      const active = pickProject(payload.project ?? payload.payload?.project);
      if (!active) return json(400, { ok: false, code: "INVALID_ARGUMENT", message: "未知 project" });
      try {
        return json(200, { ok: true, result: await action(active.db, active.root, payload.payload ?? payload) });
      } catch (error) {
        return json(200, { ok: false, code: error.code ?? "E_INTERNAL", message: error.message, data: error.data ?? null });
      }
    }
    return json(404, { ok: false, code: "NOT_FOUND" });
  };

  // 任何一条畸形请求都不能打死守护进程
  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      try {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, code: error.code ?? "E_INTERNAL", message: String(error.message ?? error) }));
      } catch {
        /* 连接已断 */
      }
    });
  });
  server.on("clientError", (_error, socket) => {
    try {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    } catch {
      /* ignore */
    }
  });

  // 端口被占用时给人一句能看懂的话，而不是把 Node 的 EADDRINUSE 堆栈甩到脸上
  const probe = () =>
    new Promise((res) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/api/meta", timeout: 800 }, (r) => {
        let body = "";
        r.on("data", (c) => (body += c));
        r.on("end", () => {
          try {
            res(JSON.parse(body));
          } catch {
            res(null);
          }
        });
      });
      req.on("error", () => res(null));
      req.on("timeout", () => {
        req.destroy();
        res(null);
      });
    });

  return new Promise((resolve) => {
    let settled = false;
    const done = (code) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    server.on("error", async (error) => {
      if (error.code !== "EADDRINUSE") {
        console.error(`控制台没起来：${error.message}`);
        return done(1);
      }
      const meta = await probe();
      const isConsole = meta?.app === "devcontrol";
      const same = isConsole && meta.root && path.resolve(meta.root) === path.resolve(root);
      if (same) {
        console.log(`这个项目的控制台已经在跑了：http://127.0.0.1:${port}/（进程 ${meta.pid}）`);
        console.log("直接打开上面的地址就行；要重开就先 devcontrol serve --stop，或者换个端口。");
      } else if (isConsole) {
        console.log(`端口 ${port} 被另一个项目的控制台占着：${meta.root}`);
        console.log(`换个端口：devcontrol serve --port ${port + 1}`);
      } else {
        console.log(`端口 ${port} 被别的程序占着。换个端口：devcontrol serve --port ${port + 1}`);
      }
      return done(0);
    });
    server.listen(port, "127.0.0.1", () => {
      console.log(`devcontrol 控制台：http://127.0.0.1:${port}`);
      console.log(`项目：${root}`);
      if (refreshed.length) {
        console.log(`Agent 说明已同步：${refreshed.join("、")}`);
        console.log("这些文件跟仓库走，建议随手 commit 一下。");
      }
      // 「连接即控制台生命周期」：MCP 断开后宽限期到点自己收摊，别留 PPID 1 的孤儿进程
      const parentPid = Number(process.env.DEVCONTROL_PARENT_PID ?? 0);
      if (parentPid > 0) {
        const graceMs = Number(process.env.DEVCONTROL_PARENT_GRACE_MS ?? 10000);
        let goneAt = 0;
        setInterval(() => {
          let alive = true;
          try {
            process.kill(parentPid, 0);
          } catch {
            alive = false;
          }
          if (alive) {
            goneAt = 0;
            return;
          }
          if (!goneAt) goneAt = Date.now();
          if (Date.now() - goneAt < graceMs) return;
          console.log("MCP 已断开，控制台自行退出。");
          server.close();
          done(0);
        }, 2000).unref();
      }
    });
    server.on("close", () => done(0));
    process.on("SIGINT", () => server.close());
  });
}