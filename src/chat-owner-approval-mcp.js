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

/**
 * 审批有两种形态，摘要必须把它算进去，否则「先批需求」和「只批 Path」会被当成同一件事：
 *   · first    —— 需求还是 draft：需求 + Path 一起批（原有流程）
 *   · path-only —— 需求已批准：只冻这条新 Path，需求的验收和状态一律不动
 */
export function approvalMode(req, path) {
  if (!req) return null;
  if (req.status === "draft") return "first";
  if (["approved", "building"].includes(req.status)) return "path-only";
  return null;
}

function digest(req, pth, mode) {
  return createHash("sha256").update(safeJson({
    mode,
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
  if (!req) return { ok: false, code: "E_NEED_APPROVED", message: `需求 ${requirementId} 不存在` };
  const mode = approvalMode(req, path);
  if (!mode) {
    return { ok: false, code: "E_NEED_APPROVED", message: `需求 ${requirementId} 处于 ${req.status}，不能审批` };
  }
  // first 模式沿用既有语义：Path 可被多条需求复用（rebindFrom 会提示重绑）。
  // path-only 模式必须是自己名下的草案：给已批准需求新增 Path 时，拿别家的 Path 来批
  // 等于绕过归属，所以这一条只对 path-only 生效。
  if (!path) {
    return { ok: false, code: "E_INVALID_PATH", message: `Path ${pathId} 不存在` };
  }
  if (mode === "path-only") {
    if (path.requirement_id !== requirementId) {
      return { ok: false, code: "E_INVALID_PATH", message: `Path ${pathId} 不属于需求 ${requirementId}，不能单独批准` };
    }
    if (path.status !== "draft") {
      return { ok: false, code: "E_INVALID_PATH", message: `Path ${pathId} 当前 ${path.status}，不是待批准的草案` };
    }
  } else if (path.status === "revoked") {
    return { ok: false, code: "E_INVALID_PATH", message: `Path ${pathId} 已废弃，不能批准` };
  }
  return {
    ok: true,
    mode,
    requirementId,
    pathId,
    title: req.title,
    acceptance: req.acceptance,
    allowedPaths: path.allowedPaths,
    pathTestCmds: path.testCmds,
    rebindFrom: path.requirement_id && path.requirement_id !== requirementId ? path.requirement_id : null,
    fingerprint: digest(req, path, mode),
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
    before.mode === "path-only"
      ? `只批准 Path（需求 ${requirementId} 已批准，本次不重新审需求）`
      : `需求 ${requirementId}：${before.title}`,
    `Path：${pathId}${before.rebindFrom ? `（会从 ${before.rebindFrom} 重新绑定）` : ""}`,
    `文件范围：${before.allowedPaths?.join("、") || "（未定义）"}`,
    before.mode === "path-only" ? `需求验收（本次不改）：${before.acceptance?.join("；") || "（未定义）"}` : `需求验收：${before.acceptance?.join("；") || "（未定义）"}`,
    `Path 当前验收命令：${before.pathTestCmds?.join("；") || "（未定义）"}`,
    before.mode === "path-only"
      ? "这将只冻结这条 Path 的契约，需求的验收与状态保持不变。请选择是否批准。"
      : "这将由原 DevControl 审批内核冻结契约。请选择是否批准。",
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
    // existing Owner implementations. No changes to their core logic:
    //   first     → reqApprove（需求 + Path 一起冻）
    //   path-only → pathApprove（只冻 Path，需求状态与验收不动）
    const result = await (before.mode === "path-only" ? OWNER_ACTIONS["path.approve"] : OWNER_ACTIONS.approve)(db, root, {
      requirementId, pathId, channel: "mcp-human-elicitation",
    });
    return toolResponse({
      ok: true,
      kind: before.mode === "path-only" ? "path-approved" : "approved",
      result,
      message:
        before.mode === "path-only"
          ? `Owner 已批准 Path ${pathId}（需求 ${requirementId} 未重新审批），可继续开发。`
          : `Owner 已批准 ${requirementId}/${pathId}，已生成契约。可在此对话中继续执行后续开发。`,
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
