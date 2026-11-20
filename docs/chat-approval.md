# 对话授权：Owner Chat Approval（与模型厂商无关）

DevControl 的审批权仍属于 **Owner**。新功能只增加消息入口；**没有修改** `reqApprove`、门禁、任务认领、契约冻结或 SQLite 结构。

## 本地控制台：开箱即用

打开 `http://127.0.0.1:7373/` → **收件箱** → **对话授权**。

可输入：

- `待审批`：列出草稿需求。
- `批准`：只有一个草稿需求、一个可用 Path 时才自动匹配。
- `批准 FR-002`：只有一个可用 Path 时才自动匹配。
- `批准 FR-002 使用 P-001`：显式指定需求与 Path。

对于任何审批，控制台先展示需求标题、验收断言、Path 原有命令与文件范围，再让真人点击确认。之后调用原来的 `/api/owner` → `approve`。取消确认无任何副作用，批准事件记录 `channel=console-chat`。

**不会将**「好」「继续」「批准所有」「Agent 建议批准……」等模糊/引用性文本解释为审批。

## 其它聊天客户端（Claude / Codex / Pi / ChatGPT / 自建聊天等）

任意具有**可信真人消息接收能力**的 Host 可接入：

`POST http://127.0.0.1:7373/api/chat/owner-message`

这是一个 **Host-to-DevControl** 入口，不是提供给模型或 Agent 调用的工具。Host 负责验证消息确实由当前已认证的 Owner 在对话中发送（而不是模型输出、工具输出、粘贴的引用或伪造字段）。DevControl 验证 Host 的签名、消息时效、去重、草稿状态和目标范围，然后复用原有 Owner 审批动作。

### 配置

1. 在**可信的 Host 服务进程**及 DevControl 控制台配置相同的 `DEVCONTROL_CHAT_APPROVAL_SECRET`，建议使用独立生成的至少 32 字节随机值（例如用 Node `randomBytes(32).toString("hex")` 生成）。不要在聊天、日志、Prompt、Agent 工具环境中传递这个密钥。
2. 重启 `devcontrol serve`；没有有效密钥时此接口默认关闭。
3. 可信 Host 必须与 DevControl 运行在同一台机器，使用 loopback 访问。请勿通过 FRP/Cloudflare Tunnel 暴露此接口；如需手机审批，由 Agent Studio 的已认证 Host 转发**已验证的真人消息**。

### 请求格式

Headers:

```http
Content-Type: application/json
X-DevControl-Chat-Time: 1795171200000
X-DevControl-Chat-Signature: sha256=<hex>
```

`X-DevControl-Chat-Time` 使用当前 Unix 毫秒时间戳（以上只是格式示例），签名为：

```js
import { createHmac } from "node:crypto";
const timestamp = String(Date.now());
const rawBody = JSON.stringify(event);
const signature = createHmac("sha256", secret)
  .update(`${timestamp}.${rawBody}`)
  .digest("hex");
```

Body（`connector` 只是 Host 标识，可填 `claude`、`codex`、`pi`、`chatgpt`、`custom` 等）：

```json
{
  "eventId": "owner-turn-20261120-00001",
  "connector": "pi",
  "authorRole": "owner",
  "project": "E:/workspace/github/agent studio",
  "message": "批准",
  "context": {
    "requirementId": "FR-002",
    "pathId": "P-001"
  }
}
```

也可以在 `message` 中明确写 `批准 FR-002 使用 P-001`，无需 `context`；但不能只用没有目标的孤立「批准」。`context` 必须由 Host 从**可信的待审批请求或会话关联记录**中选取，不能直接照抄 Agent 模型生成的内容。

成功响应：

```json
{
  "ok": true,
  "kind": "approved",
  "result": { "requirementId": "FR-002", "pathId": "P-001", "contractCommit": "...", "hash": "..." }
}
```

审计事件的 `channel` 为 `chat:<connector>`。无签名、过期（超过 2 分钟）、重放（同进程内）、非 Owner 身份、无明确目标、非草稿需求或不匹配的上下文，均不执行批准。服务器重启后的重复消息仍受草稿状态校验，不会把旧「批准」绑定到另一个需求。

### 信任边界（必须遵守）

- 不要把 `DEVCONTROL_CHAT_APPROVAL_SECRET` 作为 MCP 工具参数、模型提示词、Agent 进程环境变量或远端浏览器凭据。只交给不受 Agent 控制的可信 Host 后台。
- `authorRole=owner` **不是身份凭证**：服务端信任的是签名对应的 Host；Host 必须自行根据其聊天平台的用户身份体系，验证该消息来自真实 Owner。仅凭 Agent 提供的 `authorRole` 不能批准。
- 签名保护的是完整 HTTP 原始 body + 时间戳；Host 不应重签 Agent 改写或总结的文字。
- 新入口目前只支持**需求批准**；「放行门禁」「删除/作废」「修改验收」等高风险 Owner 动作仍须使用原有控制台流程，不允许自由文本绕过。
- 本机 `/api/chat/preview` 仅解析意图，不执行授权；`/api/chat/owner-message` 也不暴露为 Agent MCP action。
- 与 ChatGPT/Claude/Codex/Pi 的具体 Chat UI 连接仍需要各自提供可信真人消息事件的 Host 适配器；仅安装 DevControl 不等于自动获得第三方聊天平台的身份验证能力。

## 测试

```sh
node --test test/owner-chat.test.js test/console-ui.test.js test/console-owner-actions.test.js test/capabilities.test.js
```
