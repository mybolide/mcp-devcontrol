// Provider-neutral in-conversation Owner approval.
//
// This is deliberately NOT an action of the Agent's devcontrol dispatcher.
// The Agent may request approval, but it cannot provide a confirmation in tool
// arguments. A capable MCP client MUST elicit the Owner's decision out-of-band.
// This keeps the original reqApprove/contract/SQLite gate untouched.
import { createHash } from "node:crypto";
import { z } from "zod";
import { listPaths, listReqs } from "./store.js";
import { OWNER_ACTIONS } from "./console.js";

export const CHAT_APPROVAL_TOOL = "devcontrol_request_owner_approval";

function safeJson(value) {
  return JSON.stringify(value);
}

function digest(req, pth) {
  return createHash("sha256").update(safeJson({
    requirementId: req.id,
    status: req.status,
    title: req.title,
    acceptance: req.acceptance,
    pathId: pth.id,
    pathStatus: pth.status,
    linkedRequirement: pth.requirement_id,
    allowedPaths: pth.allowedPaths,
    testCmds: pth.testCmds,
    budget: pth.budget_lines,
    contractCommit: pth.contract_commit,
  })).digest("hex");
}

function toolResponse(result, error = false) {
  return { content: [{ type: "text", text: JSON.stringify(result) }], ...(error ? { isError: true } : {}) };
}

/** The same gate is used before and after the human sees the confirmation. */
export function getApprovalPreview(db, requirementId, pathId) {
  const req = listReqs(db).find((r) => r.id === requirementId);
  const path = listPaths(db).find((p) => p.id === pathId);
  if (!req || req.status !== "draft") return { ok: false, code: "E_NEED_APPROVED", message: `需求 ${requirementId} 不存在或不处于草稿状态` };
  if (!path || (path.requirement_id && path.status !== "approved")) {
    return { ok: false, code: "E_INVALID_PATH", message: `Path ${pathId} 不存在或无法复用` };
  }
  return {
    ok: true,
    requirementId,
    pathId,
    title: req.title,
    acceptance: req.acceptance,
    allowedPaths: path.allowedPaths,
    pathTestCmds: path.testCmds,
    rebindFrom: path.requirement_id && path.requirement_id !== requirementId ? path.requirement_id : null,
    fingerprint: digest(req, path),
  };
}

export async function requestOwnerApproval({ db, root, requirementId, pathId, elicit, clientSupportsElicitation }) {
  const before = getApprovalPreview(db, requirementId, pathId);
  if (!before.ok) return toolResponse(before, true);
  if (!clientSupportsElicitation || typeof elicit !== "function") {
    return toolResponse({
      ok: false,
      code: "E_OWNER_CONFIRMATION_UNAVAILABLE",
      message: "当前聊天客户端未提供可信真人确认通道，未批准任何需求。请使用支持 MCP elicitation 的客户端，或接入已认证的 Host 消息桥。",
      preview: before,
    });
  }
  // The model can pick a target to request, but the *client* owns this form.
  // Never accept {approved:true}, a token, or a quoted user message from tool arguments.
  const details = [
    `需求 ${requirementId}：${before.title}`,
    `Path：${pathId}${before.rebindFrom ? `（会从 ${before.rebindFrom} 重新绑定）` : ""}`,
    `文件范围：${before.allowedPaths?.join("、") || "（未定义）"}`,
    `需求验收：${before.acceptance?.join("；") || "（未定义）"}`,
    `Path 当前验收命令：${before.pathTestCmds?.join("；") || "（未定义）"}`,
    "这将由原 DevControl 审批内核冻结契约。请选择是否批准。",
  ];
  let decision;
  try {
    decision = await elicit({
      mode: "form",
      message: details.join("\n"),
      requestedSchema: {
        type: "object",
        properties: {
          decision: {
            type: "string",
            title: "Owner 决定",
            description: `仅批准需求 ${requirementId} 使用 ${pathId}，不授予 Agent 其他权限`,
            enum: ["批准", "拒绝"],
          },
        },
        required: ["decision"],
      },
    });
  } catch (_error) {
    return toolResponse({ ok: false, code: "E_OWNER_CONFIRMATION_UNAVAILABLE", message: "客户端无法完成真人审批确认；没有执行批准。" });
  }
  if (decision?.action !== "accept" || decision?.content?.decision !== "批准") {
    return toolResponse({ ok: false, code: "E_OWNER_DECLINED", message: `Owner 未批准 ${requirementId}/${pathId}，项目状态未改变。` });
  }
  // A newly arrived requirement, changed acceptance, or rebound Path must
  // invalidate an old confirmation rather than approve a different contract.
  const after = getApprovalPreview(db, requirementId, pathId);
  if (!after.ok || before.fingerprint !== after.fingerprint) {
    return toolResponse({ ok: false, code: "E_APPROVAL_STALE", message: "确认期间需求或 Path 内容发生变化，请重新查看并批准。" });
  }
  try {
    // Leave all validation, contract creation, audit and DB transactions to the
    // existing Owner implementation. No changes to its core logic.
    const result = await OWNER_ACTIONS.approve(db, root, {
      requirementId, pathId, channel: "mcp-human-elicitation",
    });
    return toolResponse({
      ok: true,
      kind: "approved",
      result,
      message: `Owner 已批准 ${requirementId}/${pathId}，已生成契约。可在此对话中继续执行后续开发。`,
    });
  } catch (error) {
    return toolResponse({ ok: false, code: error.code ?? "E_APPROVAL_FAILED", message: error.message }, true);
  }
}

export function registerChatOwnerApproval(server, { db, root }) {
  server.registerTool(
    CHAT_APPROVAL_TOOL,
    {
      title: "向 Owner 申请批准需求（需聊天客户端真人确认）",
      description:
        "Only requests Owner approval for a specific draft requirement and Path. Requires interactive MCP client elicitation. The Agent cannot approve by passing parameters; missing/declined human confirmation never changes DevControl state.",
      inputSchema: {
        requirementId: z.string().regex(/^FR-\d+$/),
        pathId: z.string().regex(/^P-\d+$/),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ requirementId, pathId }) => {
      const capabilities = server.server.getClientCapabilities?.();
      return requestOwnerApproval({
        db, root, requirementId, pathId,
        clientSupportsElicitation: Boolean(capabilities?.elicitation?.form),
        elicit: (request) => server.server.elicitInput(request),
      });
    },
  );
}
