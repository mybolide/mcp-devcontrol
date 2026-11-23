// DevControl Owner 对话意图：纯规则解析，不调用模型，也不拥有审批权限。
// 本模块只解释人类消息。授权与执行仍由 console 的受信任入口和 store.reqApprove 负责。
//
// 唯一的活调用方是控制台的 `/api/chat/owner-message`（Host 签名的真人消息，`trustedContext: true`）。
// 控制台曾经有个「对话授权」输入框直接调这里，已经删掉了——本机审批就是收件箱里点一下，
// 少一条把自然语言变成授权的路径，就少一处要防伪造的地方。

const APPROVE = /^(?:我\s*)?(?:批准|同意|approve)(?:\s*需求)?(?:\s+(FR-\d+))?(?:\s+(?:使用\s*|--path\s+)?(P-\d+))?\s*[。！!]?$/iu;
const LIST = /^(?:待审批|查看待审批|有哪些待审批|待批准|审批列表|pending)(?:\s*[？?])?$/iu;
const HELP = /^(?:帮助|怎么批准|help)(?:\s*[？?])?$/iu;

export function resolveOwnerChat(message, { requirements = [], paths = [], context = {}, trustedContext = false } = {}) {
  const text = typeof message === "string" ? message.trim() : "";
  if (!text || text.length > 160) return { kind: "invalid", text: "请输入简短的审批指令，例如「待审批」「批准 FR-002 使用 P-001」。" };

  if (HELP.test(text)) return { kind: "help", text: "输入「待审批」查看草稿需求；输入「批准 FR-002 使用 P-001」批准。只有一个待审批需求时，控制台内可直接说「批准」。" };

  if (LIST.test(text)) {
    const pending = requirements.filter((r) => r.status === "draft").map((r) => ({ id: r.id, title: r.title, acceptance: r.acceptance }));
    return { kind: "list", pending, text: pending.length ? `待审批需求：${pending.map((r) => `${r.id} ${r.title}`).join("；")}` : "没有待审批需求。" };
  }

  const m = APPROVE.exec(text);
  if (!m) return { kind: "invalid", text: "我只识别明确的审批指令。「继续」「好」「批准所有」或 Agent 自述都不会触发审批。" };

  const explicitReqId = m[1]?.toUpperCase();
  const explicitPathId = m[2]?.toUpperCase();
  const contextualReqId = trustedContext && typeof context.requirementId === "string" ? context.requirementId.toUpperCase() : undefined;
  const contextualPathId = trustedContext && typeof context.pathId === "string" ? context.pathId.toUpperCase() : undefined;
  // 远程聊天不能依赖「此刻唯一一个待审批」来猜目标；必须通过明确 ID 或
  // 经过可信 Host 签名的关联上下文绑定目标，避免断线重放时批准到下一条需求。
  const remote = Boolean(trustedContext);
  const drafts = requirements.filter((r) => r.status === "draft");
  const reqId = explicitReqId ?? contextualReqId ?? (!remote && drafts.length === 1 ? drafts[0].id : undefined);
  if (!reqId) return { kind: "clarify", text: "请指定需求编号，例如「批准 FR-002 使用 P-001」。" };
  const req = requirements.find((r) => r.id === reqId);
  if (!req || req.status !== "draft") return { kind: "invalid", text: `${reqId} 不是待审批需求，未执行任何操作。` };
  if (explicitReqId && contextualReqId && explicitReqId !== contextualReqId) {
    return { kind: "invalid", text: "消息中的需求与可信会话上下文不匹配。" };
  }
  if (explicitPathId && contextualPathId && explicitPathId !== contextualPathId) {
    return { kind: "invalid", text: "消息中的 Path 与可信会话上下文不匹配。" };
  }

  const candidates = paths.filter((p) => !p.requirement_id || p.status === "approved");
  const pathId = explicitPathId ?? contextualPathId ?? (!remote && candidates.length === 1 ? candidates[0].id : undefined);
  if (!pathId) return { kind: "clarify", text: `请为 ${reqId} 指定 Path，例如「批准 ${reqId} 使用 P-001」。` };
  const chosen = candidates.find((p) => p.id === pathId);
  if (!chosen) return { kind: "invalid", text: `Path ${pathId} 不存在或不可复用，未执行任何操作。` };
  return {
    kind: "approve",
    requirementId: req.id,
    pathId: chosen.id,
    rebindFrom: chosen.requirement_id && chosen.requirement_id !== req.id ? chosen.requirement_id : null,
    title: req.title,
    acceptance: req.acceptance,
    testCmds: chosen.testCmds,
    allowedPaths: chosen.allowedPaths,
    text: `确认批准 ${req.id}（${req.title}），使用 ${chosen.id}${chosen.requirement_id && chosen.requirement_id !== req.id ? `，从 ${chosen.requirement_id} 重新绑定` : ""}？`,
  };
}
