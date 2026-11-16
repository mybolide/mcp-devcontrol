// devcontrol — Agent 侧安装物：规范 Skill + 各客户端指针 + AGENTS/CLAUDE 块
// 思路同 v5：正文只有一份（.agents/skills/<name>/SKILL.md），别的客户端只放指针，避免多份内容各自漂移。
import fs from "node:fs";
import path from "node:path";
import { VERSION } from "./protocol.js";

export const SKILL_NAME = "devcontrol";
export const SKILL_REL = ".agents/skills/devcontrol/SKILL.md";
export const CURSOR_RULE_REL = ".cursor/rules/devcontrol.mdc";
export const CLAUDE_REL = "CLAUDE.md";
export const AGENTS_REL = "AGENTS.md";

const BEGIN = "<!-- devcontrol:begin — 自动生成，勿手改 -->";
const END = "<!-- devcontrol:end -->";

/** Skill 正文：Agent 真正要读的「法」 */
export function skillBody({ noMcp = false } = {}) {
  // 内容不按「有没有接 MCP」分叉：init 与 MCP 启动写出来的必须完全一致，否则会互相覆盖
  const first = "`bootstrap`（MCP）或 `devcontrol status`（CLI）";
  return `# devcontrol —— 本项目的研发纪律

这个项目的需求、任务、验收与证据都在 \`.devcontrol/state.db\` 里，由 devcontrol 内核管。
你要做的事，由内核告诉你，不要自己挑。

## 一轮的唯一流程

1. 开工先问内核：${first}。返回的 \`next\` 就是你现在该做的那件事。
2. 按 \`next.args\` **原样执行**（参数是给全的；缺参数会收到 \`INVALID_ARGUMENT\`）。
3. 改代码只能动 \`claim\` 返回的 \`scope\` 里的文件。
4. \`devcontrol commit -m "..."\`：只提交 scope 内的文件，自动写 Task-Id。
5. \`devcontrol close\`：内核在**干净检出**里重跑验收，全过才算 done。

## Owner 的动作不在 MCP 里

MCP 工具列表里**没有**批准需求、放行、打回、改预算这些动作——这是故意的，
它们只在控制台（\`devcontrol serve\`）里，由人点。

所以碰到下面这些情况，**不要试、不要绕、更不要自己改库**，直接告诉人去做：

| 你要什么 | 人的动作（控制台） |
|---|---|
| 需求/Path 还没批准 | 「收件箱」里点批准 |
| 想改验收标准 | 「需求」页改（走需求变更，不是改任务） |
| 动了依赖或既有测试被拦 | 「任务」页点放行，写理由（≥12 字） |
| 任务太大超预算 | 「需求」页点预算数字改，或把任务拆小 |
| 验收命令过期（项目换了 test 脚本） | 「需求」页点「重采」 |
| 任务做完但验收过不了 | 只能改到过；放行由人决定 |

控制台地址在 \`devcontrol status\` 的 \`console\` 字段；没起来就 \`devcontrol serve\`。

## 硬规则（违反会被拦，不是建议）

- 不许改 acceptance、不许自选命令：验收命令在 Owner 批准 Path 时已经冻结。
- 一个任务只改自己的 scope；**scope 相交的任务不能同时开工**。
- 失败过的任务再 close 必须带 \`--resolved-by\`（一句话：最后怎么解决的）。
- 遇到歧义用 \`ask\`，不要猜。

## 被拦了怎么办

| 错误码 | 怎么办 |
|---|---|
| \`E_NEED_APPROVED\` | 需求或 Path 还没批准，等 Owner 在控制台批 |
| \`E_CLAIMED_BY_OTHER\` / \`E_SCOPE_OVERLAP\` / \`E_WIP_LIMIT\` | 等别人收口，或换一个不冲突的任务 |
| \`E_NO_DELIVERY\` | 还没有本任务的提交，先 commit |
| \`E_SCOPE_VIOLATION\` | 改了 scope 外的文件，撤掉 |
| \`E_ASSERTION_FAILED\` | 验收没过，去控制台「证据」看退出码 |
| \`E_NEED_RESOLUTION\` | 补 \`--resolved-by\` 再 close |
| \`E_MEMORY_CANDIDATE\` | 记忆写得太具体，按提示模板改写后再写一次 |

## 多个 Agent 并行时必读

每个 Agent 用**不同的** \`DEVCONTROL_ACTOR\`（MCP 里传 \`actor\`）。
两个 Agent 用同一个 actor 名，第二个会被 WIP=1 挡住，要等 45 分钟租约过期才恢复。

## 同类需求怎么复用

- 先看有没有现成模板：\`devcontrol flow list\`
- 这次做得好，就沉淀下来：\`devcontrol flow save <名字> --from FR-001\`
- 下次同类需求：\`devcontrol flow apply <名字>\` 建需求草稿（批准仍由 Owner 做），再照模板拆任务

## 记忆

\`memory\` 是**本项目**的经验库（\`.devcontrol/memory.db\`）：动手前先搜，踩完坑再写。
只写以后还会用到的通则，不写「这次改了第 12 行」。
`;
}

export function skillContent(opts = {}) {
  return `---
name: ${SKILL_NAME}
description: >-
  本项目的研发纪律：开工先问内核，改代码前 claim，只改 scope 内文件，
  收口由内核在干净检出里重跑验收。所有动作走 devcontrol 工具或 devcontrol CLI。
version: "${VERSION}"
---

${skillBody(opts)}
`;
}

export function agentsBlock() {
  const open = "`bootstrap`（MCP）/ `devcontrol status`（CLI）";
  const consoleLine = "控制台地址在 `devcontrol status` 的 console 字段；接了 MCP 会自动拉起，没接就自己 `devcontrol serve`。";
  return `${BEGIN}
开工先跑 ${open}：它返回的 \`next\` 就是下一件事，不要自己挑。
改代码前必须 task.claim；不许修改 acceptance，不许自选命令；只改 scope 内的文件。
改完 \`devcontrol commit -m "..."\`（只提交 scope 内文件），再 \`devcontrol close\`（内核在干净检出里重跑验收）。
遇到歧义用 ask，不要猜。
${consoleLine}
多 Agent 并行时，每个 Agent 用自己的 \`DEVCONTROL_ACTOR\`，否则会被 WIP=1 挡住。
完整规矩见 \`${SKILL_REL}\`。
${END}`;
}

export function cursorRule() {
  return `---
description: devcontrol 研发纪律（本项目唯一开发流程）
alwaysApply: true
---

读 \`${SKILL_REL}\`。

1. 开工先 \`devcontrol status\`（MCP 里是 \`bootstrap\`），照它给的 \`next\` 做。
2. 改代码前 \`task.claim\`；只改 scope 内的文件。
3. 改完 \`devcontrol commit\`，再 \`devcontrol close\`（内核在干净检出里重跑验收）。
`;
}

export function claudeBlock() {
  return `${BEGIN}
本项目用 devcontrol 管研发纪律，完整规矩见 \`${SKILL_REL}\`。
开工 \`devcontrol status\`（MCP 里是 \`bootstrap\`），改代码前 \`task.claim\`，只改 scope 内文件，改完 \`commit\` 再 \`close\`。
${END}`;
}

/** 把带标记的块写进某个文件：已有同名块就整块替换，没有就追加（不吞用户原有内容） */
export function upsertBlock(file, block) {
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const pattern = /<!-- devcontrol:begin[\s\S]*?<!-- devcontrol:end -->/;
  if (pattern.test(current)) {
    const next = current.replace(pattern, block);
    if (next === current) return "unchanged";
    fs.writeFileSync(file, next, "utf8");
    return "updated";
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${block}\n`, "utf8");
  return "created";
}

function writeIfChanged(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (current === content) return "unchanged";
  fs.writeFileSync(file, content, "utf8");
  return current === null ? "created" : "updated";
}

/**
 * 安装 Agent 侧的全部文件。返回每个文件的状态，供 init 打印与提交。
 * 规范 Skill 只有一份，其余都是指针 —— 内容不会各自漂移。
 */
/** 项目在用哪个客户端，就只给它装指针：不用的别往仓库里塞文件 */
function usesClaude(root) {
  return fs.existsSync(path.join(root, CLAUDE_REL)) || fs.existsSync(path.join(root, ".claude"));
}
function usesCursor(root) {
  return fs.existsSync(path.join(root, ".cursor"));
}

export function installAgentFiles(root, opts = {}) {
  const out = {};
  // 规范说明 + AGENTS.md 是通用约定，一直写
  out[SKILL_REL] = writeIfChanged(path.join(root, SKILL_REL), skillContent(opts));
  out[AGENTS_REL] = upsertBlock(path.join(root, AGENTS_REL), agentsBlock(opts));
  if (usesClaude(root)) out[CLAUDE_REL] = upsertBlock(path.join(root, CLAUDE_REL), claudeBlock());
  if (usesCursor(root)) out[CURSOR_RULE_REL] = writeIfChanged(path.join(root, CURSOR_RULE_REL), cursorRule());
  return out;
}
