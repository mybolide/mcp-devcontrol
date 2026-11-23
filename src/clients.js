// devcontrol — 客户端探测：这个项目在用哪些 MCP 客户端
//
// 为什么要有这个模块：早先 `init` 无条件写 `.mcp.json` / `.cursor/mcp.json` /
// `opencode.json` 三份。一个只用 Claude Code 的仓库凭空多出 `.cursor/` 和
// `opencode.json` —— 那不是配置，是噪音：谁也不知道这两份该不该留、改了会不会被
// 下一次 init 覆盖，还得先学会我们的 ignore 规则才敢删。
//
// 现在的约定：
//   · `.mcp.json` 照写。它是 MCP 的通用入口（Claude Code 等直接读它），
//     不写就等于 init 完还得手工配一遍，那「三步开始」就是假的。
//   · 客户端私有配置（`.cursor/mcp.json`、`opencode.json`）只在**这个项目确实
//     在用那个客户端**时才写；`--mcp-for cursor,opencode` 可以显式要求。
//
// 判据必须和 agent 说明文件（`.cursor/rules`、`CLAUDE.md`）用同一套：
// 两处判据一旦漂移，就会出现「写了 .cursor/mcp.json 却没有 .cursor/rules」这种半套配置。
import fs from "node:fs";
import path from "node:path";

/** 通用 MCP 配置：所有客户端都认 */
export const MCP_REL = ".mcp.json";
/** Cursor：目录在就说明这个项目在用 Cursor */
export const CURSOR_DIR = ".cursor";
export const CURSOR_MCP_REL = ".cursor/mcp.json";
/** OpenCode */
export const OPENCODE_REL = "opencode.json";
export const OPENCODE_DIR = ".opencode";
/** Claude Code */
export const CLAUDE_REL = "CLAUDE.md";
export const CLAUDE_DIR = ".claude";

const exists = (root, rel) => fs.existsSync(path.join(root, rel));

export function usesCursor(root) {
  return exists(root, CURSOR_DIR);
}

export function usesClaude(root) {
  return exists(root, CLAUDE_REL) || exists(root, CLAUDE_DIR);
}

export function usesOpenCode(root) {
  // 已经有 opencode.json（哪怕只是 `{}`）或 .opencode/ 都算在用：
  // 用户建这个文件就是在告诉我们要用 OpenCode
  return exists(root, OPENCODE_REL) || exists(root, OPENCODE_DIR);
}

const KNOWN = ["cursor", "opencode", "claude"];

/**
 * 解析 `--mcp-for cursor,opencode` / `--mcp-for all`。
 * 不认识的客户端名直接报错：悄悄忽略会让人以为配置写好了。
 */
export function parseMcpFor(value) {
  if (value === undefined || value === null || value === true || value === "") return null;
  const names = String(value)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!names.length) return null;
  if (names.includes("all")) return new Set(KNOWN);
  const unknown = names.filter((n) => !KNOWN.includes(n));
  if (unknown.length) {
    throw Object.assign(
      new Error(`E_INVALID: 不认识的客户端 ${unknown.join(", ")}（可选：${KNOWN.join(" / ")} / all）`),
      { code: "E_INVALID" },
    );
  }
  return new Set(names);
}

/**
 * 这次 init 该写哪些客户端配置。
 *
 * @param {string} root
 * @param {{forced?: Set<string>|null}} opts forced = `--mcp-for` 的结果（优先于探测）
 * @returns {{picked: Record<string, boolean>, inUse: Record<string, boolean>, why: Record<string, string>}}
 */
export function resolveClients(root, { forced = null } = {}) {
  const inUse = { cursor: usesCursor(root), opencode: usesOpenCode(root), claude: usesClaude(root) };
  const picked = { cursor: false, opencode: false, claude: false };
  const why = {};
  for (const name of KNOWN) {
    if (forced) {
      picked[name] = forced.has(name);
      if (picked[name]) why[name] = "forced";
      continue;
    }
    picked[name] = inUse[name];
    if (picked[name]) why[name] = "detected";
  }
  return { picked, inUse, why };
}