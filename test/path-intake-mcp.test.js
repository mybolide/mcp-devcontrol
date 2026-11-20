import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp.js";
import { getPath } from "../src/store.js";
import { makeRepo, initFlow } from "./helpers.js";

function fixture() {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  return {
    root,
    db,
    reqId,
    cleanup: () => {
      db.close();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    },
  };
}

test("MCP path.create is available to the Agent but only creates an unapproved draft", async () => {
  const f = fixture();
  const server = createServer({ db: f.db, root: f.root, consoleUrl: async () => null });
  const client = new Client({ name: "path-intake-test", version: "0.0.1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = await client.listTools();
    const main = tools.tools.find((tool) => tool.name === "devcontrol");
    assert.ok(main.inputSchema.properties.action.enum.includes("path.create"));
    const response = await client.callTool({
      name: "devcontrol",
      arguments: {
        action: "path.create",
        requirementId: f.reqId,
        allowedPaths: ["docs/spikes/plugin-contract.mjs", "docs/spikes/plugin-contract.test.mjs"],
        allowNewFiles: true,
        budgetLines: 600,
        testCmds: ["node --test docs/spikes/plugin-contract.test.mjs", "git diff --check"],
      },
    });
    const result = JSON.parse(response.content[0].text);
    assert.equal(result.id, "P-002");
    assert.equal(result.status, "draft");
    assert.equal(result.requiresOwnerApproval, true);
    assert.equal(getPath(f.db, "P-002").status, "draft");
    assert.equal(getPath(f.db, "P-002").contract_commit, null);
  } finally {
    await client.close();
    await server.close();
    f.cleanup();
  }
});
