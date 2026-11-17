// devcontrol — MCP stdio 服务（官方 SDK：@modelcontextprotocol/sdk）
// 单工具 devcontrol，13 个动作；连接即拉起 Owner 控制台
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openDb } from "./db.js";
import { bootstrap } from "./digest.js";
import { VERSION } from "./protocol.js";
import { installAgentFiles } from "./skill.js";
import { recordEvidence, taskCreate, taskClaim, taskRenew, taskClose, bugReport, ask } from "./gates.js";
import { hintFor } from "./hints.js";
import { resolveRoot } from "./cli.js";
import { ensureConsole, readConsoleMeta } from "./console-boot.js";
import { fail, getTask, logRejection, mapTask } from "./store.js";
import { generalizeHint, memoryConfig, openMemory, recallMemories, rememberAndIndex, searchMemories } from "./memory.js";
import { createRelease, planRelease, shipRelease } from "./release.js";

export const TOOL_NAME = "devcontrol";

export const INSTRUCTIONS = `你是本项目的编码 Agent。工作纪律（由 devcontrol 内核强制）：
1. 第一个动作必须是 devcontrol.bootstrap。它返回的 next 就是**你现在该做的下一件事**（内核已按依赖和验收覆盖排好序），不要自己挑；actions 是当前只该用的动作；plan 里是还没被任务覆盖的验收，拆任务时照它来。
2. 改代码前必须 task.claim；只改任务 scope 内的文件；不许改 acceptance 或自选命令。
3. 完成后 devcontrol commit -m "..."（只提交 scope 内文件），再 task.close —— 内核不跑你的测试，它核验你留下的证据：命令在契约白名单里、是在当前这份代码上跑的、退出码满足断言。
4. 遇到歧义用 ask，不要猜。
5. bootstrap 返回的 console 地址就是 Owner 控制台：MCP 启动时自动拉起、挂掉时 bootstrap 自动重建。把它转告 Owner 即可，人不需要手动启动或重启。
6. memory 是**这个项目自己的经验库**（存在本仓库 .devcontrol/memory.db，不写远程）：踩到的坑/解法、定下的约定、踩过的 SDK 怪癖，随时可以 memory.write（title + body + kind/tags）；动手前先用 memory.search 查一下。任务失败过（bootstrap.task.reviewRound > 0）时，task.close 必须带 resolvedBy，内核会自动记一条 pitfall。`;

export const ACTIONS = [
  "bootstrap",
  "wait",
  // 在办、但还没写码/没留证据：这一步没有内核动作可调（活是 Agent 自己干的），
  // 但必须是合法枚举——否则 next 让它做 task.work，它一调就报「非法动作」。
  "task.work",
  "task.create",
  "task.claim",
  "task.renew",
  "task.close",
  "evidence.record",
  "bug.report",
  "ask",
  "memory.write",
  "memory.search",
  "release.create",
  "release.plan",
  "release.ship",
];

export const SCHEMA = {
  action: z.enum(ACTIONS).describe("要执行的动作"),
  id: z.string().optional().describe("任务号 / 发布号"),
  requirementId: z.string().optional(),
  pathId: z.string().optional(),
  kind: z.string().optional().describe("feature|bugfix|chore|test，或记忆类型 pitfall|howto|decision|preference|snippet|note"),
  title: z.string().optional(),
  acceptance: z
    .array(z.object({ deriveFrom: z.number().optional(), assertion: z.string() }))
    .optional()
    .describe("验收：assertion 形如 'npm test :: exit==0'，deriveFrom 指向需求验收下标"),
  dependsOn: z.array(z.string()).optional(),
  scope: z.array(z.string()).optional(),
  budgetLines: z.number().optional(),
  symptom: z.string().optional(),
  expected: z.string().optional(),
  repro: z.array(z.string()).optional(),
  severity: z.string().optional(),
  resolvedBy: z.string().optional().describe("失败过的任务必填：一句话说清最后怎么解决的（自动写进通用记忆）"),
  body: z.string().optional().describe("memory.write 的内容：现象 + 原因 + 解法"),
  tags: z.array(z.string()).optional(),
  project: z.string().optional().describe("可选的出处仓库名（只是溯源）"),
  query: z.string().optional().describe("memory.search 的检索词"),
  limit: z.number().optional(),
  tasks: z.array(z.string()).optional().describe("release.plan 要挂进来的任务号"),
  targetDate: z.string().optional().describe("release.create 的目标日期 YYYY-MM-DD"),
  taskId: z.string().optional(),
  question: z.string().optional(),
  command: z.string().optional().describe("evidence.record：你刚跑完的那条验收命令（原文，要和契约里的一致）"),
  exit: z.number().optional().describe("evidence.record：那条命令的退出码"),
  output: z.string().optional().describe("evidence.record：可选，输出片段（截断 20k）"),
  actor: z.string().optional().describe("领取者标识，默认 agent（与 devcontrol commit --actor 一致）"),
  options: z.array(z.string()).optional(),
};

/** 动作分发：SDK 只负责协议，业务全在这里 */
export async function dispatch(db, root, args, ctx = {}) {
  // 参数缺失在这里就拦下：交给 SQLite 绑定只会抛 ERR_INVALID_ARG_TYPE，把数据库内部细节泄给 Agent
  const REQUIRED = {
    "task.create": ["requirementId", "pathId", "title"],
    "task.claim": ["id"],
    "evidence.record": ["command"],
    "task.renew": ["id"],
    ask: ["taskId", "question"],
    "bug.report": ["title", "symptom"],
    "release.create": ["title"],
    "release.plan": ["id"],
    "release.ship": ["id"],
  };
  const missing = (REQUIRED[args.action] ?? []).filter((k) => args[k] === undefined || args[k] === null || args[k] === "");
  if (missing.length) {
    throw Object.assign(new Error(`${args.action} 缺少参数：${missing.join("、")}（照 bootstrap.next.args 原样传即可）`), {
      code: "INVALID_ARGUMENT",
    });
  }
  switch (args.action) {
    case "bootstrap": {
      const doing = db.prepare("SELECT * FROM tasks WHERE status='doing' ORDER BY id LIMIT 1").get();
      const memory = await recallMemories(root, doing ? mapTask(doing) : null);
      return bootstrap(db, root, { console: ctx.consoleUrl ? await ctx.consoleUrl() : null, memories: memory.memories });
    }
    case "wait":
    case "task.work": {
      // next.action 可能就是 wait / task.work：允许 Agent 调它们，返回当前状态
      // 而不是让 schema 报「非法枚举」。task.work 的内核回答是「该你干活了」，
      // 而不是代替它干活——所以这里只回现状与步骤。
      const doing = db.prepare("SELECT * FROM tasks WHERE status='doing' ORDER BY id LIMIT 1").get();
      return bootstrap(db, root, { console: ctx.consoleUrl ? await ctx.consoleUrl() : null, memories: (await recallMemories(root, doing ? mapTask(doing) : null)).memories });
    }
    case "task.create":
      return taskCreate(db, root, args, args.actor ?? process.env.DEVCONTROL_ACTOR ?? "agent");
    case "task.claim":
      return taskClaim(db, root, args, args.actor ?? process.env.DEVCONTROL_ACTOR ?? "agent");
    case "task.renew":
      return taskRenew(db, root, args, args.actor ?? process.env.DEVCONTROL_ACTOR ?? "agent");
    case "evidence.record": {
      // 测试是 Agent 自己跑的（用它自己的 shell）。这里只接收「跑完了，结果是这个」，
      // 内核不执行任何命令——它只记账，收口时再核验这份账对不对得上当前代码。
      const actor = args.actor ?? process.env.DEVCONTROL_ACTOR ?? "agent";
      const doing = args.id
        ? [getTask(db, args.id)].filter(Boolean)
        : db.prepare("SELECT id FROM tasks WHERE status='doing' AND claimed_by=? AND closing_token IS NULL").all(actor).map((r) => getTask(db, r.id));
      if (doing.length !== 1) {
        fail("E_NO_TASK", doing.length ? `${actor} 有多个在办任务，请指明 id` : `${actor} 手上没有在办任务，证据记不了`);
      }
      const t = doing[0];
      return recordEvidence(db, root, {
        taskId: t.id,
        command: String(args.command),
        result: { exit: Number(args.exit ?? 0), stdout: String(args.output ?? ""), stderr: "", durationMs: 0 },
        scope: t.scope,
      });
    }
    case "task.close":
      return taskClose(db, root, args, { signal: ctx.signal });
    case "bug.report":
      return bugReport(db, args, args.actor ?? process.env.DEVCONTROL_ACTOR ?? "agent");
    case "ask":
      return ask(db, args);
    case "release.create":
      return createRelease(db, { title: String(args.title ?? ""), targetDate: args.targetDate ?? null });
    case "release.plan":
      return planRelease(db, { id: args.id, tasks: args.tasks });
    case "release.ship":
      return shipRelease(db, { id: args.id, root });
    case "memory.write": {
      const result = await rememberAndIndex({
        title: String(args.title ?? ""),
        body: String(args.body ?? ""),
        kind: args.kind ?? "note",
        tags: args.tags ?? [],
        project: args.project ?? null,
        source: "agent",
        projectTokens: args.project ? [String(args.project)] : [],
      });
      if (result?.status === "candidate") result.hint = generalizeHint(result.reasons ?? []);
      return result;
    }
    case "memory.search": {
      const cfg = memoryConfig(process.env, root);
      const mem = openMemory(cfg);
      try {
        return await searchMemories(cfg, mem, { query: String(args.query ?? ""), limit: Number(args.limit ?? 5) });
      } finally {
        mem.close();
      }
    }
    default:
      throw Object.assign(new Error(`未知 action：${args.action}`), { code: "INVALID_ARGUMENT" });
  }
}

/**
 * 把结果序列化成工具返回文本。
 * 注意：绝不能对 JSON 字符串做 slice——那会产出非法 JSON，客户端解析必失败。
 * 太大时按字段裁剪（并且一定保持合法 JSON）。
 */
export function compact(result, limit = 12000) {
  const payload = { ok: true, ...result };
  let text = JSON.stringify(payload);
  if (text.length <= limit) return text;

  const trimmed = { ...payload, truncated: true };
  if (Array.isArray(trimmed.memories)) {
    trimmed.memories = trimmed.memories.map((m) => ({ ...m, body: String(m.body ?? "").slice(0, 240) }));
  }
  if (Array.isArray(trimmed.runs)) trimmed.runs = trimmed.runs.slice(0, 5);
  if (Array.isArray(trimmed.commits)) trimmed.commits = trimmed.commits.slice(0, 5);
  if (Array.isArray(trimmed.recent)) trimmed.recent = trimmed.recent.slice(0, 3);
  text = JSON.stringify(trimmed);
  if (text.length <= limit) return text;
  return JSON.stringify({ ok: true, truncated: true, note: "结果过大已裁剪；完整数据用 CLI 查：devcontrol status / export" });
}

/** 组装 MCP server（供 runMcp 与测试复用） */
export function createServer({ db, root, consoleUrl }) {
  const server = new McpServer({ name: TOOL_NAME, version: VERSION }, { instructions: INSTRUCTIONS, capabilities: { tools: {} } });
  server.registerTool(
    TOOL_NAME,
    {
      title: "研发纪律内核",
      description:
        "Project development discipline kernel. action=bootstrap; task.create/claim/close (verifies the evidence you recorded — it never runs your tests); bug.report; ask; memory.write/memory.search (cross-project engineering memory); release.create/plan/ship.",
      inputSchema: SCHEMA,
      annotations: { readOnlyHint: false },
    },
    async (args, extra) => {
      try {
        const result = await dispatch(db, root, args, { consoleUrl, signal: extra?.signal });
        return { content: [{ type: "text", text: compact(result) }] };
      } catch (error) {
        // 记一笔拒绝：stats 的「被拦」靠它。CLI 那边走 failCli，这边是唯一入口。
        try {
          logRejection(db, process.env.DEVCONTROL_ACTOR, error.code ?? "E_INTERNAL");
        } catch {
          /* 记不上不能影响错误返回 */
        }
        // 失败的样子必须和 CLI 一模一样：ok/code/message/data/hint。
        // Agent 主要走 MCP，这里少一个 hint，等于把「下一步该干什么」丢在了另一条路上。
        const payload = {
          ok: false,
          code: error.code ?? "E_INTERNAL",
          message: error.message,
          data: error.data ?? null,
          hint: hintFor(error),
        };
        return { content: [{ type: "text", text: JSON.stringify(payload) }], isError: true };
      }
    },
  );
  return server;
}

export async function runMcp() {
  const root = resolveRoot();
  const db = openDb(root);

  // MCP 每次连上都把 Agent 说明按当前代码对齐：升级后（哪怕版本号没变）也能自愈。
  // 但有任务在办时先不动——说明文件在任务 scope 外，改了会把工作树弄脏、把 commit/close 卡死。
  const busy = db.prepare("SELECT id FROM tasks WHERE status='doing' LIMIT 1").get();
  if (!busy) {
    const refreshed = Object.entries(installAgentFiles(root)).filter(([, status]) => status !== "unchanged");
    if (refreshed.length) {
      // stdout 是 JSON-RPC 通道，日志只能走 stderr
      const detail = refreshed.map(([rel, status]) => `${rel}（${status === "created" ? "新建" : "更新"}）`).join("、");
      process.stderr.write(`[devcontrol] Agent 说明已同步：${detail}（记得 commit）\n`);
    }
  }
  const consoleReady = ensureConsole(root).catch(() => null);
  // bootstrap 时校验一次：控制台被停掉/崩了就地重建，人不该手动重启
  const consoleUrl = async () => {
    const cached = await Promise.race([consoleReady, new Promise((resolve) => setTimeout(() => resolve(null), 4000))]);
    const url = cached?.url ?? null;
    if (url) {
      const port = Number(new URL(url).port);
      if (await readConsoleMeta(port)) return url;
    }
    const again = await ensureConsole(root).catch(() => null);
    return again?.url ?? null;
  };

  const server = createServer({ db, root, consoleUrl });
  const transport = new StdioServerTransport();
  // 客户端随时可能断开：写 stdout 的 EPIPE 不算错误
  process.stdout.on("error", () => {});
  await server.connect(transport);
  // SDK 的 StdioServerTransport 只在显式 close 时回调 onclose；
  // 客户端直接关管道（stdin EOF）时要自己收尾，否则进程挂住。
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    const prevOnClose = transport.onclose;
    transport.onclose = () => {
      try {
        prevOnClose?.();
      } catch {
        /* SDK 内部清理失败不影响我们退出 */
      }
      finish();
    };
    process.stdin.on("end", finish);
    process.stdin.on("close", finish);
  });
  try {
    await transport.close();
  } catch {
    /* 已经关了 */
  }
  return 0;
}