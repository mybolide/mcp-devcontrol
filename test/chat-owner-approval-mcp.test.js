import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp.js";
import { CHAT_APPROVAL_TOOL, requestOwnerApproval } from "../src/chat-owner-approval-mcp.js";
import { makeRepo, initFlow } from "./helpers.js";
import { reqIntake } from "../src/store.js";

function fixture() {
  const root = makeRepo();
  const { db } = initFlow(root);
  const intake = reqIntake(db, root, {
    title: "Host 后台测试",
    goal: "daemon integration",
    acceptance: ["npm test :: exit==0"],
  });
  assert.equal(intake.id, "FR-002");
  return {
    root, db,
    cleanup: () => {
      db.close();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    },
    requirementStatus: () => db.prepare("SELECT status FROM requirements WHERE id='FR-002'").get().status,
  };
}

function output(result) {
  return JSON.parse(result.content[0].text);
}

async function connection(data, { humanConfirmation = "批准", supportsElicitation = true } = {}) {
  let calls = 0;
  const server = createServer({ db: data.db, root: data.root, consoleUrl: async () => null });
  const client = new Client({ name: "owner-chat-mcp-test", version: "0.0.1" }, {
    capabilities: supportsElicitation ? { elicitation: { form: {} } } : {},
  });
  if (supportsElicitation) {
    client.setRequestHandler(ElicitRequestSchema, async ({ params }) => {
      calls++;
      assert.equal(params.mode, "form");
      assert.match(params.message, /FR-002/);
      assert.match(params.message, /P-001/);
      assert.match(params.message, /npm test/);
      return humanConfirmation === null ? { action: "decline" } : {
        action: "accept",
        content: { decision: humanConfirmation },
      };
    });
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const close = async () => { await client.close(); await server.close(); };
  return { client, close, getCalls: () => calls };
}

test("Agent 启动请求但客户端不支持真人确认时，不得批准", async () => {
  const f = fixture();
  try {
    const conn = await connection(f, { supportsElicitation: false });
    try {
      const tool = await conn.client.callTool({ name: CHAT_APPROVAL_TOOL, arguments: {
        requirementId: "FR-002", pathId: "P-001",
      } });
      assert.equal(output(tool).code, "E_OWNER_CONFIRMATION_UNAVAILABLE");
      assert.equal(conn.getCalls(), 0);
      assert.equal(f.requirementStatus(), "draft");
    } finally { await conn.close(); }
  } finally { f.cleanup(); }
});

test("用户拒绝（包括未操作）不会批准；仅 Agent 工具参数不足以批准", async () => {
  const f = fixture();
  try {
    const conn = await connection(f, { humanConfirmation: null });
    try {
      const tool = await conn.client.callTool({ name: CHAT_APPROVAL_TOOL, arguments: {
        requirementId: "FR-002", pathId: "P-001",
      } });
      assert.equal(output(tool).code, "E_OWNER_DECLINED");
      assert.equal(conn.getCalls(), 1);
      assert.equal(f.requirementStatus(), "draft");
    } finally { await conn.close(); }
  } finally { f.cleanup(); }
});

test("真人在聊天客户端明确确认后，才走原 DevControl 审批与审计", async () => {
  const f = fixture();
  try {
    const conn = await connection(f);
    try {
      const tool = await conn.client.callTool({ name: CHAT_APPROVAL_TOOL, arguments: {
        requirementId: "FR-002", pathId: "P-001",
      } });
      const response = output(tool);
      assert.equal(response.ok, true, JSON.stringify(response));
      assert.equal(response.result.requirementId, "FR-002");
      assert.equal(conn.getCalls(), 1);
      assert.equal(f.requirementStatus(), "approved");
      const event = f.db.prepare("SELECT channel FROM events WHERE action='req.approve' ORDER BY id DESC LIMIT 1").get();
      assert.equal(event.channel, "mcp-human-elicitation");
      assert.equal(f.db.prepare("SELECT requirement_id FROM paths WHERE id='P-001'").get().requirement_id, "FR-002");
    } finally { await conn.close(); }
  } finally { f.cleanup(); }
});

test("确认过程中验收内容发生变化，旧审批不生效", async () => {
  const f = fixture();
  try {
    const result = await requestOwnerApproval({
      db: f.db, root: f.root, requirementId: "FR-002", pathId: "P-001",
      clientSupportsElicitation: true,
      elicit: async () => {
        f.db.prepare("UPDATE requirements SET acceptance_json=? WHERE id='FR-002'")
          .run(JSON.stringify(["node --test :: exit==0"]));
        return { action: "accept", content: { decision: "批准" } };
      },
    });
    assert.equal(output(result).code, "E_APPROVAL_STALE");
    assert.equal(f.requirementStatus(), "draft");
  } finally { f.cleanup(); }
});
