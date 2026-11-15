// devcontrol — MCP 连接即控制台的生命周期触发器（对齐 v5 的做法）
// 目标：Agent 一接上 MCP，Owner 的控制台就已经在跑了；人不该先敲 devcontrol serve。
// 取舍：控制台跑在**独立进程**里（MCP 重启不打断阅读），但去掉 v5 的锁文件与实例注册表。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { VERSION } from "./protocol.js";
import { readSettings } from "./settings.js";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/devcontrol.js", import.meta.url));
export const START_PORT = 7373;
export const PORT_ATTEMPTS = 12;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));


/** 自己的控制台刚起来多久之内不重启（避免多个 MCP 连着启动时来回杀） */
export function restartGraceMs(root = process.env.DEVCONTROL_ROOT || process.cwd()) {
  const raw = Number(process.env.DEVCONTROL_RESTART_GRACE_MS ?? readSettings(root).console.restartGraceMs ?? 10_000);
  return Number.isFinite(raw) && raw >= 0 ? raw : 10_000;
}
/** 探测端口上是不是 devcontrol 控制台；不是/超时都返回 null */
export function readConsoleMeta(port, timeout = 400) {
  return new Promise((resolve) => {
    let done = false;
    const settle = (value) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      resolve(value);
    };
    // 整体 deadline：慢速滴流会把 socket 的 idle timeout 一直重置，必须自己兜住
    const deadline = setTimeout(() => {
      try {
        req.destroy();
      } catch {
        /* ignore */
      }
      settle(null);
    }, timeout * 3);
    const req = http.get({ hostname: "127.0.0.1", port, path: "/api/meta", timeout }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
        if (body.length > 8192) res.destroy();
      });
      res.on("end", () => {
        try {
          const meta = JSON.parse(body);
          settle(res.statusCode === 200 && meta.app === "devcontrol" && typeof meta.root === "string" ? { ...meta, port } : null);
        } catch {
          settle(null);
        }
      });
      res.on("close", () => settle(null));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => settle(null));
  });
}

export function canBind(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

export function consoleLogPath(root) {
  const tag = crypto.createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 12);
  return path.join(os.tmpdir(), `devcontrol-console-${tag}.log`);
}

async function spawnConsole(root, port, waitMs) {
  const log = consoleLogPath(root);
  const out = fs.openSync(log, "a");
  let child;
  try {
    child = spawn(process.execPath, [BIN, "serve", "--port", String(port)], {
      cwd: root,
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env, DEVCONTROL_ROOT: root, DEVCONTROL_CONSOLE: "0", DEVCONTROL_PARENT_PID: String(process.pid), DEVCONTROL_PARENT_GRACE_MS: "10000" },
    });
    child.unref();
    // 异步 spawn 失败（EAGAIN/EMFILE/cwd 被删）会触发 error 事件，不接住会打死 MCP 自己
    child.on("error", () => {});
  } finally {
    fs.closeSync(out);
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(150);
    const meta = await readConsoleMeta(port);
    if (meta && path.resolve(meta.root) === path.resolve(root)) {
      return { url: `http://127.0.0.1:${port}/`, port, reused: false, pid: meta.pid ?? child.pid ?? null };
    }
    if (child.exitCode !== null) break;
  }
  if (child.pid) {
    try {
      process.kill(child.pid, "SIGTERM");
    } catch {
      /* 已经退了 */
    }
    for (let i = 0; i < 10; i += 1) {
      await sleep(100);
      if (await canBind(port)) break;
      if (i === 9) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }
  }
  return { url: null, reason: `控制台没起来（端口 ${port}），看日志：${log}` };
}

/** 杀自己项目的控制台：SIGTERM → 等端口释放 → 还不行 SIGKILL 再等 */
async function stopOwnConsole(meta, port, waitMs = 4000) {
  if (meta.pid) {
    try {
      process.kill(meta.pid, "SIGTERM");
    } catch {
      /* 已经退出了，继续等端口释放 */
    }
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await canBind(port)) return true;
    await sleep(100);
  }
  if (meta.pid) {
    try {
      process.kill(meta.pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
  for (let i = 0; i < 15; i += 1) {
    await sleep(100);
    if (await canBind(port)) return true;
  }
  return false;
}

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10_000;

/** 每个项目一把启动锁（wx 独占创建 + 死进程/过期回收），防止并发 MCP 互相踩 */
async function acquireLock(root) {
  const dir = path.join(root, ".devcontrol");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "console.lock");
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      } finally {
        fs.closeSync(fd);
      }
      return () => fs.rmSync(file, { force: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let stale = false;
      try {
        const held = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!Number.isFinite(held.at) || Date.now() - held.at > LOCK_STALE_MS) stale = true;
        else if (!Number.isInteger(held.pid) || held.pid <= 0) stale = true;
        else {
          try {
            process.kill(held.pid, 0);
          } catch (probe) {
            stale = probe.code === "ESRCH";
          }
        }
      } catch {
        stale = true; // 半截写入的锁不算授权，也不算持久占用
      }
      if (stale) {
        fs.rmSync(file, { force: true });
        continue;
      }
      await sleep(120);
    }
  }
  return null;
}

/**
 * 保证本项目有一个**当前代码**的控制台在跑（v5 的策略）：
 * - 端口上是本项目自己的实例 → 杀掉重启（升级后不会留旧代码在跑）；
 * - 端口上是别人的（别的项目 / 别的服务）→ 换下一个端口，绝不杀；
 * - 空端口 → 直接起。
 * 整段过程在 `.devcontrol/console.lock` 下串行，避免并发 MCP 互相杀。
 */
export async function ensureConsole(root, { basePort, attempts = PORT_ATTEMPTS, waitMs = 6000 } = {}) {
  if (process.env.DEVCONTROL_CONSOLE === "0") return { url: null, skipped: true, reason: "DEVCONTROL_CONSOLE=0" };
  const project = path.resolve(root);
  const start = Number(basePort ?? process.env.DEVCONTROL_PORT ?? readSettings(project).console.port ?? START_PORT);
  const release = await acquireLock(project);
  if (!release) return { url: null, reason: "另一个进程正在启动控制台（拿不到锁），本次跳过" };
  try {
    for (let i = 0; i < attempts; i += 1) {
      const port = start + i;
      if (port > 65535) break;
      const meta = await readConsoleMeta(port);
      if (meta) {
        if (path.resolve(meta.root) !== project) continue; // 别人的 → 下一个端口
        // 同版本的健康实例直接复用：别因为「它跑了一会儿」就把 Owner 正在看的页面杀掉重启。
        // 只有版本不一致（升级过代码）才重启，避免旧代码一直跑；老实例没有 version 字段，按宽限期处理。
        const age = Date.now() - Date.parse(meta.startedAt ?? 0);
        const sameVersion = meta.version === VERSION;
        const freshEnough = !meta.version && Number.isFinite(age) && age >= 0 && age < restartGraceMs(project);
        if (sameVersion || freshEnough) {
          return { url: `http://127.0.0.1:${port}/`, port, reused: true, pid: meta.pid ?? null };
        }
        if (!(await stopOwnConsole(meta, port))) continue; // 自己的旧实例 → 杀掉，杀不干净就换端口
        const fresh = await spawnConsole(project, port, waitMs);
        if (fresh.url) return { ...fresh, restarted: true, previousPid: meta.pid ?? null };
        continue;
      }
      if (!(await canBind(port))) continue; // 被非 devcontrol 服务占着 → 下一个端口
      const fresh = await spawnConsole(project, port, waitMs);
      if (fresh.url) return fresh;
      continue; // 这个端口起不来（被抢/子进程崩了）→ 换下一个
    }
    return { url: null, reason: `端口 ${start}–${start + attempts - 1} 都不可用` };
  } finally {
    release?.();
  }
}