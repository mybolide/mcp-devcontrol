// devcontrol — 断言执行（不持写事务；超时 600s）
import { spawn } from "node:child_process";
import crypto from "node:crypto";

export const TIMEOUT_MS = 600_000;
export const MAX_OUTPUT = 1024 * 1024;

/**
 * 验收子进程的环境白名单：不把父进程的 token / cloud 凭证透传给仓库里的测试脚本。
 * 需要额外的变量请显式传进来（例如 DevControl 自己的 TASK 号）。
 */
const ENV_ALLOW = [
  "PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP", "SHELL", "USER", "LOGNAME",
  "SystemRoot", "COMSPEC", "PATHEXT",
  // Windows 上 rustup / cargo 从 USERPROFILE 找 home，从 RUSTUP_HOME / CARGO_HOME 找工具链与仓库。
  // 缺了它们，`devcontrol run -- cargo test` 会报「rustup could not choose a version of cargo」，
  // 而同一个命令在终端里明明能跑——验收证据因此永远出不来。
  // 只放这几个定位用的变量；token、云凭证一律不继承。
  "USERPROFILE", "RUSTUP_HOME", "CARGO_HOME", "RUSTUP_TOOLCHAIN",
];

export function buildEnv(extra = {}) {
  const env = { CI: "1" };
  for (const key of ENV_ALLOW) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null) env[key] = String(value);
  }
  return env;
}

export function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/**
 * 不用 `-l`：登录 shell 会 source profile，PATH / 别名 / NODE_OPTIONS 都能把
 * 一条已冻结的 `npm test` 变成别的命令。用非登录 `sh -c`，环境取白名单。
 */
function shellArgs(command) {
  return process.platform === "win32" ? ["cmd", ["/d", "/s", "/c", command]] : ["sh", ["-c", command]];
}

function killTree(child) {
  if (!child.pid) return;
  try {
    // detached 让子进程自成进程组，负 pid 才能把 npm → jest/vitest 这些孙进程一起杀掉
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* 已经退出 */
    }
  }
}

export function execCommand(cwd, command, { timeout = TIMEOUT_MS, env = {}, signal } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const [file, args] = shellArgs(command);
    const child = spawn(file, args, {
      cwd,
      env: buildEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      try {
        child.stdout?.destroy();
        child.stderr?.destroy();
      } catch {
        /* ignore */
      }
      resolve({ ...result, durationMs: Date.now() - started, truncated });
    };
    const push = (chunk, to) => {
      const text = chunk.toString("utf8");
      if (to === "out") {
        if (stdout.length < MAX_OUTPUT) stdout += text;
        else truncated = true;
      } else {
        if (stderr.length < MAX_OUTPUT) stderr += text;
        else truncated = true;
      }
    };
    child.stdout.on("data", (c) => push(c, "out"));
    child.stderr.on("data", (c) => push(c, "err"));

    const timer = setTimeout(() => {
      killTree(child);
      finish({ exit: 124, stdout, stderr: `${stderr}\n[timeout]`, timedOut: true });
    }, timeout);

    // 客户端取消（MCP notifications/cancelled）要真的停掉验收
    const onAbort = () => {
      killTree(child);
      finish({ exit: 130, stdout, stderr: `${stderr}\n[cancelled]`, cancelled: true });
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (error) => finish({ exit: 127, stdout, stderr: String(error) }));
    child.on("close", (code) => finish({ exit: code ?? 1, stdout, stderr }));
  });
}

/** 判定断言：`cmd :: exit==0` 或 `cmd :: stdout =~ /re/` */
export function evaluate(predicate, result) {
  const p = String(predicate ?? "").trim();
  if (/^exit\s*==\s*0$/.test(p)) return result.exit === 0;
  const re = p.match(/^stdout\s*=~\s*\/(.*)\/([a-z]*)$/s);
  if (re) {
    if (result.exit !== 0) return false;
    let regex;
    try {
      regex = new RegExp(re[1], re[2].includes("m") ? re[2] : `${re[2]}m`);
    } catch {
      return false;
    }
    return result.stdout.split("\n").some((line) => regex.test(line));
  }
  return false;
}