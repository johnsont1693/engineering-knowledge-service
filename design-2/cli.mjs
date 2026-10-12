import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { loadConfig, authenticate } from "./config.mjs";
import { openStore } from "./store.mjs";
import { processNextIngestionJob, enqueueIngestion, importIndexFile, runAdminAuthorized, importCanonicalIndex } from "./engine.mjs";

async function stdinText() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 25 * 1024 * 1024) throw new Error("Standard input exceeds the 25 MiB limit.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function main(args) {
  const [command, ...values] = args;
  if (command === "hash-token") {
    const token = await stdinText();
    if (!token) throw new Error("Pipe a non-empty persona token to this command.");
    process.stdout.write(`${createHash("sha256").update(token, "utf8").digest("hex")}\n`);
    return;
  }
  if (command === "verify-config") {
    const config = await loadConfig();
    process.stdout.write(JSON.stringify({
      approved: config.approved,
      configuredRepositories: config.repositories.length,
      configuredPersonas: config.personas.length,
      configuredApplicationMappings: config.applications.length,
    }) + "\n");
    return;
  }

  const config = await loadConfig();
  const token = process.env.SCOUT_PERSONA_TOKEN;
  const persona = authenticate(config, token);
  if (!persona?.admin) throw new Error("Set SCOUT_PERSONA_TOKEN to an explicitly configured administrator persona.");
  const db = await openStore();
  try {
    if (command === "enqueue") {
      const result = await runAdminAuthorized({
        token, db, action: "enqueue_ingestion", operation: current =>
          enqueueIngestion({ db, config: current, configFile: process.env.SCOUT_ENGINE_CONFIG, repositoryIds: values }),
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else if (command === "worker") {
      const result = await processNextIngestionJob({ db, configFile: process.env.SCOUT_ENGINE_CONFIG, token });
      process.stdout.write(`${JSON.stringify(result ?? { state: "idle" })}\n`);
    } else if (command === "import-index") {
      if (values.length !== 1 || !path.isAbsolute(values[0])) throw new Error("Usage: node cli.mjs import-index <absolute-index-json-path>");
      const result = await runAdminAuthorized({
        token, db, action: "import_index",
        operation: async () => importIndexFile(values[0], { db, configFile: process.env.SCOUT_ENGINE_CONFIG }),
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else if (command === "import-index-stdin") {
      const rawIndex = JSON.parse(await stdinText());
      const result = await runAdminAuthorized({
        token, db, action: "import_index",
        operation: async () => importCanonicalIndex({ rawIndex, db, configFile: process.env.SCOUT_ENGINE_CONFIG }),
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      throw new Error("Commands: hash-token, verify-config, enqueue <repo-id...>, worker, import-index <absolute-json-path>, import-index-stdin.");
    }
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`Design 2 command failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
