import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, authenticate, authorizedIndex, personaConfiguredRepositories } from "./config.mjs";
import { openStore, readIndex, audit } from "./store.mjs";
import {
  runSearch, runProfile, runCompare, runResolveApplication,
  runAdminAuthorized, importCanonicalIndex, enqueueIngestion,
} from "./engine.mjs";

const maxImportBytes = 25 * 1024 * 1024;
const maxBodyBytes = 1024 * 1024;

function send(response, status, body) {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(encoded),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  response.end(encoded);
}

function sendKnowledgeResult(response, result) {
  const partial = result.status === "partial" || result.coverage?.complete === false;
  send(response, partial ? 206 : 200, partial
    ? { ...result, error: { code: "PARTIAL_COVERAGE", message: "Results are incomplete; review per-repository coverage before relying on them." } }
    : result);
}

async function readJson(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error("Request body exceeds the size limit.");
      error.status = 413;
      error.code = "BODY_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.status = 400;
    error.code = "INVALID_JSON";
    throw error;
  }
}

function tokenFrom(request) {
  const authorization = request.headers.authorization ?? "";
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  if (!match) {
    const error = new Error("Authentication required.");
    error.status = 401;
    error.code = "UNAUTHENTICATED";
    throw error;
  }
  return match[1];
}

function ensureLocalOnly(request) {
  if (request.headers.origin) {
    const error = new Error("Browser-origin requests are not accepted.");
    error.status = 403;
    error.code = "BROWSER_ORIGIN_DENIED";
    throw error;
  }
  const host = request.headers.host ?? "";
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(host)) {
    const error = new Error("Local host header required.");
    error.status = 403;
    error.code = "LOCAL_HOST_REQUIRED";
    throw error;
  }
}

export async function startApi({ port = Number(process.env.PORT ?? 8765), configFile = process.env.SCOUT_ENGINE_CONFIG } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT must be an integer from 0 to 65535.");
  const db = await openStore();
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      const index = readIndex(db);
      send(response, 200, { status: "ok", indexed: Boolean(index) });
      return;
    }
    try {
      ensureLocalOnly(request);
      const token = tokenFrom(request);
      const requestConfig = await loadConfig(configFile);
      const requestPersona = authenticate(requestConfig, token);
      if (!requestPersona) throw Object.assign(new Error("Authentication required."), { status: 401, code: "UNAUTHENTICATED" });
      const url = new URL(request.url, "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/v1/repositories") {
        const index = readIndex(db);
        if (!index) throw Object.assign(new Error("No repository knowledge has been collected or imported."), { status: 503, code: "NO_INDEXED_CONTENT" });
        const scoped = authorizedIndex(requestConfig, requestPersona, index);
        const configured = personaConfiguredRepositories(requestConfig, requestPersona);
        const current = await loadConfig(configFile);
        const currentPersona = authenticate(current, token);
        if (!currentPersona || currentPersona.id !== requestPersona.id ||
            JSON.stringify(current) !== JSON.stringify(requestConfig) || scoped.repositories.some(repo =>
          !current.repositories.some(source => source.id === repo.id && source.commit === repo.commit &&
            source.accessGroup === repo.accessGroup && source.approved &&
            currentPersona.accessGroups.includes(source.accessGroup)))) {
          throw Object.assign(new Error("Authorization changed while the request was running."), { status: 403, code: "AUTHORIZATION_CHANGED" });
        }
        const indexedById = new Map(scoped.repositories.map(repo => [repo.id, repo]));
        const repositories = configured.map(repo => {
          const indexed = indexedById.get(repo.id);
          return indexed && indexed.commit === repo.commit
            ? {
                id: indexed.id, displayName: indexed.displayName, commit: indexed.commit,
                collectedAt: indexed.collectedAt, status: indexed.status, fileCount: indexed.fileCount,
                errors: indexed.errors ?? [],
              }
            : {
                id: repo.id, displayName: repo.displayName, commit: repo.commit,
                collectedAt: null, status: "not_indexed", fileCount: 0, errors: [],
              };
        });
        const indexedContentIds = new Set(scoped.chunks.map(chunk => chunk.repositoryId));
        const complete = repositories.every(repo => repo.status === "complete" && indexedContentIds.has(repo.id));
        audit(db, requestPersona.id, "list_repositories", "succeeded", repositories.length);
        send(response, complete ? 200 : 206, {
          status: complete ? "complete" : "partial",
          ...(complete ? {} : { error: { code: "PARTIAL_COVERAGE", message: "Some accessible repositories are not fully indexed." } }),
          repositories,
          coverage: { complete, repositoriesWithoutContent: repositories.filter(repo => !indexedContentIds.has(repo.id)).map(repo => repo.id) },
        });
      } else if (request.method === "POST" && url.pathname === "/v1/search") {
        sendKnowledgeResult(response, await runSearch(token, db, await readJson(request, maxBodyBytes), configFile));
      } else if (request.method === "POST" && url.pathname === "/v1/compare") {
        sendKnowledgeResult(response, await runCompare(token, db, await readJson(request, maxBodyBytes), configFile));
      } else if (request.method === "POST" && url.pathname === "/v1/applications/resolve") {
        sendKnowledgeResult(response, await runResolveApplication(token, db, await readJson(request, maxBodyBytes), configFile));
      } else if (request.method === "GET" && /^\/v1\/repositories\/[^/]+\/profile$/.test(url.pathname)) {
        const repositoryId = decodeURIComponent(url.pathname.split("/")[3]);
        sendKnowledgeResult(response, await runProfile(token, db, { repositoryId }, configFile));
      } else if (request.method === "POST" && url.pathname === "/v1/admin/import") {
        if (!requestPersona.admin) throw Object.assign(new Error("Administrator authorization required."), { status: 403, code: "ADMIN_REQUIRED" });
        const rawIndex = await readJson(request, maxImportBytes);
        const result = await runAdminAuthorized({
          token, db, action: "import_index", configFile,
          operation: async config => importCanonicalIndex({ rawIndex, db, configFile, config }),
        });
        send(response, 200, result);
      } else if (request.method === "POST" && url.pathname === "/v1/admin/ingestion-jobs") {
        if (!requestPersona.admin) throw Object.assign(new Error("Administrator authorization required."), { status: 403, code: "ADMIN_REQUIRED" });
        const input = await readJson(request, maxBodyBytes);
        const result = await runAdminAuthorized({
          token, db, action: "enqueue_ingestion", configFile,
          operation: config => enqueueIngestion({ db, configFile, config, repositoryIds: input.repositoryIds }),
        });
        send(response, 202, result);
      } else if (request.method === "GET" && /^\/v1\/admin\/ingestion-jobs\/[0-9a-f-]+$/i.test(url.pathname)) {
        const jobId = url.pathname.split("/").at(-1);
        const result = await runAdminAuthorized({
          token, db, action: "read_ingestion_job", configFile,
          operation: async () => {
            const job = db.prepare("SELECT id, repo_id AS repositoryId, state, created_at AS createdAt, updated_at AS updatedAt, error_code AS errorCode, error_message AS errorMessage FROM ingestion_jobs WHERE id=?").get(jobId);
            if (!job) throw Object.assign(new Error("Job not found."), { status: 404, code: "NOT_FOUND" });
            return { ...job, resultCount: 1 };
          },
        });
        send(response, 200, result);
      } else {
        send(response, 404, { error: { code: "NOT_FOUND", message: "Resource not found." } });
      }
    } catch (error) {
      send(response, error.status ?? 500, {
        error: {
          code: error.code ?? "INTERNAL_ERROR",
          message: error.status === 404 ? "Resource not found." : (error.status ? error.message : "Request failed."),
        },
      });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return { server, db, address: server.address() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startApi().then(({ address }) => {
    process.stderr.write(`Local API listening on http://127.0.0.1:${address.port}\n`);
  }).catch(error => {
    process.stderr.write(`API startup failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
