// devcontrol — Owner 控制台（本地 web，127.0.0.1，Owner 动作只在这里）
import http from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readConsoleMeta } from "./console-boot.js";
import { dataDir, dbPath, openDb } from "./db.js";
import { readContract } from "./contract.js";
import { taskCreate } from "./gates.js";
import { VERSION } from "./protocol.js";
import { bootstrap } from "./digest.js";
import {
  reqIntake,
  reqApprove,
  reqAmend,
  pathAdjust,
  pathApprove,
  pathRetest,
  taskAdjust,
  taskReopen,
  taskRank,
  taskRelease,
  reqAbandon,
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
import { weekly, verdict } from "./weekly.js";
import { listReleases, shipRelease } from "./release.js";
import { resolveOwnerChat } from "./owner-chat.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, "..", "public");

/** 每个 Owner 动作的必填参数。缺了就报 INVALID_ARGUMENT，别让 SQLite 去抛绑定错误。 */
const REQUIRED = {
  intake: ["title"],
  approve: ["requirementId", "pathId"],
  amend: ["requirementId"],
  adjust: ["taskId"],
  reopen: ["taskId"],
  abandon: ["requirementId"],
  decide: ["bugId"],
  answer: ["questionId"],
  override: ["taskId"],
  handoff: ["taskId"],
  release: ["taskId"],
  "task.add": ["requirementId", "pathId", "title"],
  "task.rank": ["taskId"],
  "path.adjust": ["pathId"],
  "path.retest": ["pathId"],
  // 只冻一条 Path（需求已批准时的路径）：同样只走 Owner 通道，不进 MCP dispatcher。
  "path.approve": ["pathId"],
  "memory.promote": ["id"],
  "memory.edit": ["id"],
  "memory.drop": ["id"],
  "release.ship": ["id"],
  "settings.save": ["settings"],
};

const RAW_ACTIONS = {
  intake: (db, root, p) => reqIntake(db, root, p),
  approve: (db, root, p) => reqApprove(db, root, p),
  amend: (db, root, p) => reqAmend(db, root, p),
  adjust: (db, root, p) => taskAdjust(db, root, p),
  reopen: (db, root, p) => taskReopen(db, p),
  abandon: (db, root, p) => reqAbandon(db, root, p),
  decide: (db, root, p) => bugDecide(db, p),
  answer: (db, root, p) => answer(db, p),
  override: (db, root, p) => override(db, p),
  "path.adjust": (db, root, p) => pathAdjust(db, root, p),
  "path.retest": (db, root, p) => pathRetest(db, root, p),
  "path.approve": (db, root, p) => pathApprove(db, root, p),
  handoff: (db, root, p) => handoff(db, p, root),
  release: (db, root, p) => taskRelease(db, p),
  // Owner 直接下单：单人场景里人心里已经知道要做什么，没必要非得等 Agent 拆出机器标题。
  // 校验走的是同一个 taskCreate —— 需求没批准、验收不在白名单，Owner 也一样过不去。
  "task.add": (db, root, p) => taskCreate(db, root, p),
  "task.rank": (db, root, p) => taskRank(db, p),
  "memory.promote": async (db, root, p) => promoteMemory(memoryConfig(process.env, root), p.id),
  "memory.edit": async (db, root, p) => editMemory(memoryConfig(process.env, root), p.id, { title: p.title, body: p.body }, { promote: true }),
  "memory.drop": (db, root, p) => ({ dropped: softDeleteMemory(memoryConfig(process.env, root), p.id) }),
  "release.ship": (db, root, p) => shipRelease(db, { id: p.id, root }),
  "settings.save": (db, root, p) => writeSettings(root, p.settings ?? p),
};

/**
 * 参数守卫包在最外层：缺参数时抛领域错误，而不是把
 * "ERR_INVALID_ARG_TYPE: Provided value cannot be bound to SQLite parameter 1"
 * 这种内部错误甩到页面上。和 MCP 侧的做法保持一致。
 */
function withRequired(fn, params) {
  return (db, root, p) => {
    const missing = params.filter((k) => p?.[k] === undefined || p?.[k] === null || p?.[k] === "");
    if (missing.length) {
      const err = new Error(`${missing.join("、")} 不能为空`);
      err.code = "INVALID_ARGUMENT";
      throw err;
    }
    return fn(db, root, p);
  };
}

export const OWNER_ACTIONS = Object.fromEntries(
  Object.entries(RAW_ACTIONS).map(([name, fn]) => [name, withRequired(fn, REQUIRED[name] ?? [])]),
);

export async function startConsole(args) {
  const root = resolveRoot();
  const portIdx = args.indexOf("--port");
  const port = Number(portIdx >= 0 ? args[portIdx + 1] : process.env.DEVCONTROL_PORT ?? 7373);
  // 默认只听回环：这台机器之外谁也连不上。Owner 有两台机器时才显式 --host 打开局域网。
  const hostIdx = args.indexOf("--host");
  const bindHost = String(hostIdx >= 0 ? args[hostIdx + 1] : process.env.DEVCONTROL_HOST ?? "127.0.0.1").trim() || "127.0.0.1";
  const IS_LOOPBACK_BIND = /^(127\.0\.0\.1|localhost|::1)$/i.test(bindHost);
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
  const projects = roots.map((r) => ({ root: r, name: path.basename(r) || r, db: openDb(r), dbIno: inodeOf(r) }));
  /** 库文件的 inode：文件被删掉重建后 inode 会变，这是「句柄过期」唯一可靠的信号 */
  function inodeOf(r) {
    try {
      return fs.statSync(dbPath(r)).ino;
    } catch {
      return null;
    }
  }
  /**
   * 库文件被换掉（rm -rf .devcontrol 后重新 init，或者从备份恢复）时，控制台手里的句柄
   * 还指着那个已被删除的 inode：Owner 在页面上批准，写进的是看不见的旧文件，
   * Agent 那边永远读不到，只会看到「需求未批准」。每次请求前对一下 inode，换过就重开。
   */
  function freshDb(p) {
    const now = inodeOf(p.root);
    if (now && p.dbIno && now !== p.dbIno) {
      try {
        p.db.close();
      } catch {
        /* 老句柄关不掉也不要紧，重开就行 */
      }
      p.db = openDb(p.root);
      p.dbIno = inodeOf(p.root);
    }
    return p.db;
  }
  // 控制台一启动就把 Agent 侧说明补/更新一遍：老项目 init 过也不会缺，版本升级自动跟上。
  // 有任务在办时跳过——这些文件在任务 scope 外，改了会把工作树弄脏、把收口卡死。
  const refreshed = [];
  for (const p of projects) {
    const busy = p.db.prepare("SELECT 1 FROM tasks WHERE status='doing' LIMIT 1").get();
    if (busy) continue;
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
  /**
   * 令牌是**可选**加固，不是进门门槛。
   * 这是研发工作台：Owner 大概率就在自己家的局域网里，为了打开一个页面先复制一条
   * 二十多位的链接，摩擦大于收益。所以默认不校验；想加固的人自己设
   * DEVCONTROL_OWNER_TOKEN，设了才生效。
   * （仍然保留的是 Host 白名单：它零成本，且挡的是 DNS rebinding 这类不需要你配合的攻击。）
   */
  const token = process.env.DEVCONTROL_OWNER_TOKEN ?? null;
  // 供不同聊天 Host 使用的独立密钥。只能交给可信的「真人消息入口」，
  // 绝不下发给模型、Agent 工具或浏览器。未配置时远程对话审批彻底关闭。
  const chatSecret = String(process.env.DEVCONTROL_CHAT_APPROVAL_SECRET ?? "");
  const chatBridgeEnabled = chatSecret.length >= 32;
  const seenChatMessages = new Map();
  async function readSmallJson(req, maxBytes = 8192) {
    let chunks = [];
    let length = 0;
    let tooLarge = false;
    for await (const chunk of req) {
      if (tooLarge) continue;
      length += chunk.length;
      if (length > maxBytes) { tooLarge = true; chunks = []; continue; }
      chunks.push(chunk);
    }
    if (tooLarge) return { error: { status: 413, code: "E_FORBIDDEN", message: "请求体过大" } };
    const raw = Buffer.concat(chunks).toString("utf8");
    try {
      const value = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("需要 JSON 对象");
      return { raw, value };
    } catch {
      return { error: { status: 400, code: "INVALID_ARGUMENT", message: "body 必须是 JSON 对象" } };
    }
  }
  function verifySignedChat(req, raw) {
    const stamp = String(req.headers["x-devcontrol-chat-time"] ?? "");
    const sig = String(req.headers["x-devcontrol-chat-signature"] ?? "").replace(/^sha256=/, "");
    if (!chatBridgeEnabled || !/^\d{13}$/.test(stamp) || Math.abs(Date.now() - Number(stamp)) > 120_000 || !/^[a-f0-9]{64}$/i.test(sig)) return false;
    const expected = createHmac("sha256", chatSecret).update(`${stamp}.${raw}`).digest();
    return timingSafeEqual(expected, Buffer.from(sig, "hex"));
  }
  // 允许的 Host：回环永远允许；绑了局域网就把本机各网卡 IP 一起放进来（挡 DNS rebinding 用）
  const allowedHosts = new Set();
  {
    const withPort = (h) => `${h}:${port}`;
    for (const h of ["127.0.0.1", "localhost", "[::1]"]) allowedHosts.add(withPort(h));
    if (!IS_LOOPBACK_BIND) {
      const ips = new Set([bindHost]);
      if (bindHost === "0.0.0.0" || bindHost === "::") {
        ips.clear();
        for (const list of Object.values(os.networkInterfaces())) {
          for (const info of list ?? []) if (info.family === "IPv4" && !info.internal) ips.add(info.address);
        }
      }
      for (const ip of ips) if (ip) allowedHosts.add(withPort(ip));
    }
  }
  const hostAllowed = (h) => LOOPBACK.test(String(h ?? "")) || allowedHosts.has(String(h ?? "").toLowerCase());
  /**
   * 本地控制台的访问闸门：
   * - Host 必须是回环地址（挡 DNS rebinding）
   * - 浏览器跨站请求一定带 Origin，且不等于本机来源 → 拒（挡 CSRF）
   * - POST 必须是 application/json（挡 no-cors 的 text/plain 简单请求）
   * - 若设置了 DEVCONTROL_OWNER_TOKEN，还要求请求头一致
   */
  const guard = (req) => {
    const host = String(req.headers.host ?? "");
    if (!hostAllowed(host)) {
      return {
        code: 403,
        body: { ok: false, code: "E_FORBIDDEN", message: `Host 不被信任：${host}（只有回环，或 devcontrol serve --host 指定的地址才认）` },
      };
    }
    const origin = req.headers.origin;
    if (origin) {
      let originHost = "";
      try {
        originHost = new URL(origin).host;
      } catch {
        originHost = "";
      }
      if (!hostAllowed(originHost)) {
        return { code: 403, body: { ok: false, code: "E_FORBIDDEN", message: `跨站来源：${origin}` } };
      }
    }
    if (req.method === "POST" && !String(req.headers["content-type"] ?? "").includes("application/json")) {
      return { code: 415, body: { ok: false, code: "E_FORBIDDEN", message: "只接受 application/json" } };
    }
    if (token && req.headers["x-owner-token"] !== token) {
      const had = Boolean(req.headers["x-owner-token"]);
      return {
        code: 403,
        body: {
          ok: false,
          code: "E_FORBIDDEN",
          message: had ? "令牌不对或已失效" : "缺少令牌（这个控制台对局域网开放，必须带令牌）",
          hint: "用 devcontrol serve 启动时打印的那条带 ?token= 的链接打开；令牌也可以由 DEVCONTROL_OWNER_TOKEN 固定。",
        },
      };
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
      const adb = freshDb(active);
      // 周报：Owner 不看命令行，所以这一段必须出现在页面上。
      // 天数走 ?days=，边界写死在这里而不是交给前端——前端算错了就是另一套口径。
      const rawDays = url.searchParams.get("days");
      const days = rawDays === null || rawDays === "" ? 7 : Number(rawDays);
      if (!Number.isInteger(days) || days < 1 || days > 365) {
        return json(400, { ok: false, code: "INVALID_ARGUMENT", message: `days 要是 1–365 的整数（收到 ${JSON.stringify(rawDays)}）` });
      }
      const w = weekly(adb, { days });
      return json(200, {
        project: { root: active.root, name: active.name },
        projects: projects.map((p) => ({ name: p.name, root: p.root, current: p.root === active.root })),
        digest: bootstrap(adb, active.root, { console: `http://${IS_LOOPBACK_BIND ? "127.0.0.1" : bindHost}:${port}/` }),
        requirements: listReqs(adb),
        // 规范也一起给前端：Owner 批准时得看得见「这条 Path 上要守什么」
        paths: listPaths(adb).map((pth) => {
          let standards = null;
          try {
            standards = readContract(active.root, pth.contract_commit, pth.id).body?.standards ?? null;
          } catch {
            standards = null;
          }
          return { ...pth, standards };
        }),
        tasks: listTasks(adb),
        bugs: listBugs(adb),
        docs: listDocs(adb).map((d) => {
          const abs = path.join(active.root, d.path);
          const drift = !fs.existsSync(abs) ? "missing" : sha256(fs.readFileSync(abs)) !== d.sha256 ? "changed" : null;
          return { ...d, drift };
        }),
        questions: listQuestions(adb),
        memories: listMemories(memoryConfig(process.env, active.root), 30, null, "candidate"),
        memoriesActive: listMemories(memoryConfig(process.env, active.root), 30, null, "active"),
        runs: listRuns(active.db, 30),
        releases: listReleases(adb),
        weekly: { ...w, verdict: verdict(w) },
      });
    }
    // 与模型厂商无关的可信聊天桥：只有拿到独立 HMAC 密钥的 Host 后台，
    // 才能提交它验证过的真人消息。模型/Agent 本身不能调用 Owner 动作。
    // 「批准」若未指明目标，必须带签名的会话上下文（明确需求和 Path）。
    if (req.method === "POST" && url.pathname === "/api/chat/owner-message") {
      const peer = String(req.socket.remoteAddress ?? "");
      if (!/^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/i.test(peer) ||
          !hostAllowed(req.headers.host) || req.headers.origin ||
          !String(req.headers["content-type"] ?? "").includes("application/json")) {
        return json(403, { ok: false, code: "E_FORBIDDEN", message: "聊天桥只接受本机可信 Host 的 JSON 请求" });
      }
      const body = await readSmallJson(req);
      if (body.error) return json(body.error.status, { ok: false, code: body.error.code, message: body.error.message });
      if (!verifySignedChat(req, body.raw)) return json(403, { ok: false, code: "E_FORBIDDEN", message: "聊天桥未启用或消息签名无效/已过期" });
      const p = body.value;
      if (p.authorRole !== "owner" || typeof p.eventId !== "string" || !/^[a-zA-Z0-9_:\-]{8,128}$/.test(p.eventId) ||
          typeof p.connector !== "string" || !/^[a-z0-9_-]{2,32}$/i.test(p.connector) ||
          typeof p.project !== "string" || !p.project) {
        return json(400, { ok: false, code: "INVALID_ARGUMENT", message: "只接受可信 Host 验证的真人 Owner 消息；必须提供 eventId、connector 和 project" });
      }
      // 绑定 eventId 与具体审批目标；重复投递不触发第二次重绑。
      if (seenChatMessages.has(p.eventId)) return json(409, { ok: false, code: "E_REPLAY", message: "这条真人消息已处理，不可重放" });
      const active = pickProject(p.project);
      if (!active) return json(400, { ok: false, code: "INVALID_ARGUMENT", message: "未知 project" });
      const adb = freshDb(active);
      const intent = resolveOwnerChat(p.message, {
        requirements: listReqs(adb),
        paths: listPaths(adb),
        context: p.context && typeof p.context === "object" && !Array.isArray(p.context) ? p.context : {},
        trustedContext: true,
      });
      if (intent.kind !== "approve") return json(200, { ok: false, kind: intent.kind, message: intent.text });
      // 记录在请求执行前，杜绝同一消息并发重入；状态失败时仍需新的人类消息才能重试。
      seenChatMessages.set(p.eventId, Date.now());
      for (const [key, at] of seenChatMessages) if (Date.now() - at > 600_000) seenChatMessages.delete(key);
      try {
        const result = await OWNER_ACTIONS.approve(adb, active.root, {
          requirementId: intent.requirementId, pathId: intent.pathId,
          channel: `chat:${p.connector.toLowerCase()}`,
        });
        return json(200, { ok: true, kind: "approved", result });
      } catch (error) {
        return json(200, { ok: false, code: error.code ?? "E_INTERNAL", message: error.message, data: error.data ?? null });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/owner") {
      const denied = guard(req);
      if (denied) return json(denied.code, denied.body);
      // 请求体超限要回 413，但必须先把剩下的字节排空再回：早先是先 req.destroy()
      // 再 json(413)，连接已被 reset，客户端一句都收不到（T-125）。
      const MAX_BODY = 1_000_000;
      let body = "";
      let oversized = false;
      for await (const chunk of req) {
        if (oversized) continue;
        body += chunk;
        if (body.length > MAX_BODY) {
          oversized = true;
          body = "";
        }
      }
      if (oversized) return json(413, { ok: false, code: "E_FORBIDDEN", message: "请求体过大" });
      // body 不是 JSON 是「命令写错了」，不是内核崩了：用 E_INTERNAL 会把
      // 内核故障计数虚增，也会让人以为该上报 bug（T-123）。
      const notJson = () => json(400, { ok: false, code: "INVALID_ARGUMENT", message: "body 不是 JSON" });
      let payload;
      try {
        payload = JSON.parse(body || "{}");
      } catch {
        return notJson();
      }
      // JSON.parse 还会吐 null / 数组 / 字符串 / 数字，它们没有 .action，
      // 下一行直接读就是 TypeError → HTTP 500 E_INTERNAL，同样是「打错格式算
      // 内核崩」——和 T-123 自相矛盾。先挡成 400（T-125）。
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        const kind = payload === null ? "null" : Array.isArray(payload) ? "数组" : typeof payload;
        return json(400, { ok: false, code: "INVALID_ARGUMENT", message: `body 必须是 JSON 对象，收到${kind}` });
      }
      // 只认自有键：早先用 OWNER_ACTIONS[payload.action]，于是 action=constructor /
      // toString 会沿原型链命中，200 回一句 ok:true 并把库句柄的内部属性吐出去（T-123）。
      const action = Object.hasOwn(OWNER_ACTIONS, payload.action) ? OWNER_ACTIONS[payload.action] : undefined;
      if (!action) return json(400, { ok: false, code: "INVALID_ARGUMENT", message: `未知 owner action：${payload.action}` });
      const active = pickProject(payload.project ?? payload.payload?.project);
      if (!active) return json(400, { ok: false, code: "INVALID_ARGUMENT", message: "未知 project" });
      try {
        return json(200, { ok: true, result: await action(freshDb(active), active.root, payload.payload ?? payload) });
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
      // 起不来就别假装成功：脚本会看退出码决定要不要继续（T-098）
      return done(1);
    });
    server.listen(port, bindHost, () => {
      const lanUrls = [];
      if (!IS_LOOPBACK_BIND) {
        if (bindHost === "0.0.0.0" || bindHost === "::") {
          for (const list of Object.values(os.networkInterfaces())) {
            for (const info of list ?? []) if (info.family === "IPv4" && !info.internal) lanUrls.push(`http://${info.address}:${port}`);
          }
        } else {
          lanUrls.push(`http://${bindHost}:${port}`);
        }
      }
      // 落一个 meta 文件：`devcontrol status` 的 console 字段靠它，
      // 不然每个 Agent 都得自己猜端口（T-098）。
      try {
        fs.writeFileSync(
          path.join(dataDir(root), "console.json"),
          JSON.stringify({ port, root, pid: process.pid, at: new Date().toISOString() }),
        );
      } catch {
        /* 写不了就算了，不影响控制台本身 */
      }
      console.log(`devcontrol 控制台：http://127.0.0.1:${port}`);
      if (!IS_LOOPBACK_BIND) {
        for (const u of lanUrls) console.log(`  局域网（另一台电脑直接打开）：${u}/`);
        if (token) console.log(`  已启用令牌：打开时带上 ?token=${token}（或设了 DEVCONTROL_OWNER_TOKEN 的那个人知道）`);
        else console.log("  同一局域网的人都能打开。用完 devcontrol serve --stop 就断。");
      }
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