import readline from "node:readline";
import { openStore } from "./store.mjs";
import { runSearch, runProfile, runCompare, runResolveApplication } from "./engine.mjs";

const protocolVersion = "2025-03-26";
const maxMessageBytes = 1024 * 1024;
const tools = [
  {
    name: "search_repository_code",
    description: "Search all accessible collected repository chunks using exact phrase or lexical matching. Returns every match and commit-pinned line citation; reports collection coverage and no-match status.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", minLength: 1, maxLength: 2000 },
        repositoryIds: { type: "array", items: { type: "string" }, description: "Optional narrowing only; server-side persona and repository access groups remain authoritative." },
      },
    },
  },
  {
    name: "get_repository_profile",
    description: "Return extracted, cited facts and coverage for one repository the authenticated persona may access.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repositoryId"],
      properties: { repositoryId: { type: "string" } },
    },
  },
  {
    name: "compare_repository_fact",
    description: "Enumerate a fact across every repository accessible to the authenticated persona. Missing evidence is unknown, not an inferred value.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: { kind: { type: "string", minLength: 1 }, name: { type: "string" } },
    },
  },
  {
    name: "resolve_application",
    description: "Resolve only an explicit human-approved application mapping. Repository names are never treated as application names by inference.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: { query: { type: "string", minLength: 1 } },
    },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function errorResult(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function validateToolArgs(toolName, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Tool arguments must be a JSON object.");
  const allowed = {
    search_repository_code: ["query", "repositoryIds"],
    get_repository_profile: ["repositoryId"],
    compare_repository_fact: ["kind", "name"],
    resolve_application: ["query"],
  }[toolName];
  if (!allowed || Object.keys(args).some(key => !allowed.includes(key))) throw new Error("Unknown tool or unsupported tool argument.");
}

async function main() {
  const db = await openStore();
  const token = process.env.SCOUT_PERSONA_TOKEN;
  const configFile = process.env.SCOUT_ENGINE_CONFIG;
  const handlers = {
    search_repository_code: input => runSearch(token, db, input, configFile),
    get_repository_profile: input => runProfile(token, db, input, configFile),
    compare_repository_fact: input => runCompare(token, db, input, configFile),
    resolve_application: input => runResolveApplication(token, db, input, configFile),
  };
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  for await (const line of rl) {
    if (Buffer.byteLength(line, "utf8") > maxMessageBytes) {
      errorResult(null, -32700, "Message exceeds the 1 MiB limit.");
      continue;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      errorResult(null, -32700, "Invalid JSON.");
      continue;
    }
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      errorResult(message?.id ?? null, -32600, "Invalid JSON-RPC request.");
      continue;
    }
    const hasId = Object.hasOwn(message, "id");
    try {
      if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") continue;
      if (message.method === "initialize") {
        if (!hasId) continue;
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "engineering-knowledge-local", version: "1.0.0" },
          },
        });
      } else if (message.method === "ping") {
        if (hasId) send({ jsonrpc: "2.0", id: message.id, result: {} });
      } else if (message.method === "tools/list") {
        if (hasId) send({ jsonrpc: "2.0", id: message.id, result: { tools } });
      } else if (message.method === "tools/call") {
        if (!hasId || typeof message.params?.name !== "string") throw new Error("tools/call requires an id and tool name.");
        const name = message.params.name;
        const args = message.params.arguments ?? {};
        validateToolArgs(name, args);
        const result = await handlers[name](args);
        const partial = result.status === "partial" || result.coverage?.complete === false;
        const payload = partial
          ? { ...result, error: { code: "PARTIAL_COVERAGE", message: "Results are incomplete; review per-repository coverage." } }
          : result;
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            content: [{ type: "text", text: JSON.stringify(payload) }],
            structuredContent: payload,
            isError: partial,
          },
        });
      } else {
        if (hasId) errorResult(message.id, -32601, "Method not found.");
      }
    } catch (error) {
      if (hasId) {
        const payload = {
          code: error.code ?? "TOOL_FAILED",
          message: error.status === 404 ? "Resource not found." : error.message,
        };
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text: JSON.stringify(payload) }], isError: true },
        });
      }
    }
  }
  db.close();
}

main().catch(error => {
  process.stderr.write(`Engineering knowledge MCP startup failed: ${error.message}\n`);
  process.exitCode = 1;
});
