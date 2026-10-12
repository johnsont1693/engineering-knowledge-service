import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { ingestRepositories, searchIndex, repositorySummary, compareFact, validateIndex } from "../core/index.mjs";
import { loadConfig, authenticate, authorizedIndex, personaConfiguredRepositories } from "./config.mjs";
import { verifyIndexEvidence } from "./evidence.mjs";
import { audit, readIndex, writeIndex } from "./store.mjs";

const execFile = promisify(execFileCallback);

function publicCoverage(index) {
  return index.repositories.map(({ id, displayName, commit, collectedAt, status, fileCount, errors }) => ({
    repositoryId: id,
    displayName,
    commit,
    collectedAt,
    status,
    fileCount,
    errors: errors ?? [],
  }));
}

function throwHttp(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  throw error;
}

function emptyIndex() {
  return {
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    repositories: [],
    applications: [],
    facts: [],
    chunks: [],
    warnings: [],
  };
}

export async function runAuthorized({ token, db, action, operation, configFile, allowWithoutIndex = false }) {
  const config = await loadConfig(configFile);
  const persona = authenticate(config, token);
  if (!persona) throwHttp(401, "UNAUTHENTICATED", "Authentication required.");
  const rawIndex = readIndex(db);
  if (!rawIndex && !allowWithoutIndex) throwHttp(503, "NO_INDEXED_CONTENT", "No repository knowledge has been collected or imported.");
  const scopedIndex = authorizedIndex(config, persona, rawIndex ?? emptyIndex());
  const visibleRepos = personaConfiguredRepositories(config, persona);
  audit(db, persona.id, action, "started");
  let result;
  try {
    result = await operation({ config, persona, index: scopedIndex, visibleRepos, rawIndex });
    const currentConfig = await loadConfig(configFile);
    const currentPersona = authenticate(currentConfig, token);
    const currentIndex = readIndex(db);
    if (!currentPersona || currentPersona.id !== persona.id || (!currentIndex && !allowWithoutIndex) ||
        JSON.stringify(currentConfig) !== JSON.stringify(config)) {
      throwHttp(403, "AUTHORIZATION_CHANGED", "Authorization changed while the request was running.");
    }
    const nowVisible = new Set(personaConfiguredRepositories(currentConfig, currentPersona).map(repo => repo.id));
    const captured = new Set(visibleRepos.map(repo => repo.id));
    if ([...captured].some(id => !nowVisible.has(id)) || [...nowVisible].some(id => !captured.has(id)) ||
        [...(result?.repositoryIds ?? [])].some(id => !nowVisible.has(id))) {
      throwHttp(403, "AUTHORIZATION_CHANGED", "Authorization changed while the request was running.");
    }
    audit(db, persona.id, action, "succeeded", result?.resultCount ?? null);
    return result;
  } catch (error) {
    audit(db, persona.id, action, "failed");
    throw error;
  }
}

function assertNarrowingIds(ids, repositories) {
  if (ids === undefined) return undefined;
  if (!Array.isArray(ids) || ids.some(id => typeof id !== "string")) {
    throwHttp(400, "INVALID_REPOSITORIES", "repositoryIds must be an array of repository identifiers.");
  }
  const visible = new Set(repositories.map(repo => repo.id));
  if (ids.some(id => !visible.has(id))) throwHttp(404, "NOT_FOUND", "Repository not found.");
  return [...new Set(ids)];
}

export async function searchRepositories(context, { query, repositoryIds }) {
  const { index } = context;
  if (typeof query !== "string" || !query.trim() || query.length > 2000) {
    throwHttp(400, "INVALID_QUERY", "query must be a non-empty string of at most 2000 characters.");
  }
  const authorizedRepos = context.visibleRepos;
  if (!authorizedRepos.length) throwHttp(404, "NOT_FOUND", "No accessible repository knowledge is available.");
  const ids = assertNarrowingIds(repositoryIds, authorizedRepos);
  const selectedIds = new Set(ids ?? authorizedRepos.map(repo => repo.id));
  const selectedRepos = authorizedRepos.filter(repo => selectedIds.has(repo.id));
  const indexedRepos = new Map(index.repositories.map(repo => [repo.id, repo]));
  const indexedSelectedIds = selectedRepos.filter(repo => indexedRepos.has(repo.id)).map(repo => repo.id);
  const contentRepoIds = new Set(index.chunks.map(chunk => chunk.repositoryId));
  const indexedContent = selectedRepos.some(repo => indexedRepos.has(repo.id) && contentRepoIds.has(repo.id));
  if (!indexedContent) throwHttp(503, "NO_INDEXED_CONTENT", "No source chunks are indexed for the selected accessible repositories.");
  const result = await searchIndex(index, {
    query: query.trim(),
    maxResults: Math.max(1, index.chunks.length),
    repositoryIds: indexedSelectedIds,
  });
  const completeCoverage = selectedRepos.every(repo =>
    indexedRepos.get(repo.id)?.status === "complete" && contentRepoIds.has(repo.id)) &&
    result.coverage.truncated === false;
  const status = completeCoverage ? "complete" : "partial";
  const repositoryCoverage = selectedRepos.map(repo => {
    const indexed = indexedRepos.get(repo.id);
    return indexed
      ? publicCoverage({ repositories: [indexed] })[0]
      : {
          repositoryId: repo.id,
          displayName: repo.displayName,
          commit: repo.commit,
          collectedAt: null,
          status: "not_indexed",
          fileCount: 0,
          errors: [],
        };
  });
  return {
    ...result,
    status,
    coverage: {
      ...result.coverage,
      status,
      repositories: repositoryCoverage,
      repositoriesWithoutIndexedContent: selectedRepos.filter(repo =>
        !indexedRepos.has(repo.id) || !contentRepoIds.has(repo.id)).map(repo => repo.id),
      authorizedRepositoryCount: authorizedRepos.length,
    },
    resultCount: Array.isArray(result.results) ? result.results.length : undefined,
    repositoryIds: [...selectedIds],
    answerStatus: result.results?.length ? "matches_found" : "no_exact_match",
  };
}

export async function getRepositoryProfile(context, { repositoryId }) {
  if (!context.visibleRepos.some(repo => repo.id === repositoryId)) throwHttp(404, "NOT_FOUND", "Repository not found.");
  const repo = context.index.repositories.find(candidate => candidate.id === repositoryId);
  if (!repo) throwHttp(503, "NO_INDEXED_CONTENT", "No source chunks are indexed for this accessible repository.");
  const result = await repositorySummary(context.index, repositoryId);
  if (!result.chunksIndexed) throwHttp(503, "NO_INDEXED_CONTENT", "No source chunks are indexed for this accessible repository.");
  return {
    ...result,
    repository: {
      id: repo.id,
      displayName: repo.displayName,
      commit: repo.commit,
      collectedAt: repo.collectedAt,
      status: repo.status,
      accessGroup: repo.accessGroup,
      fileCount: repo.fileCount,
      errors: repo.errors ?? [],
    },
    coverage: {
      repositories: publicCoverage({ repositories: [repo] }),
      complete: repo.status === "complete",
      status: repo.status,
      hasIndexedContent: true,
    },
    repositoryIds: [repo.id],
  };
}

export async function compareRepositoryFact(context, { kind, name }) {
  if (typeof kind !== "string" || !kind.trim() || kind.length > 200 ||
      (name !== undefined && (typeof name !== "string" || !name.trim() || name.length > 500))) {
    throwHttp(400, "INVALID_FACT", "kind and optional name must be non-empty strings.");
  }
  if (!context.visibleRepos.length) throwHttp(404, "NOT_FOUND", "No accessible repository knowledge is available.");
  if (!context.index.chunks.length) throwHttp(503, "NO_INDEXED_CONTENT", "No source chunks are indexed for accessible repositories.");
  const result = context.index.repositories.length
    ? await compareFact(context.index, { kind: kind.trim(), ...(name === undefined ? {} : { name: name.trim() }) })
    : [];
  const contentRepoIds = new Set(context.index.chunks.map(chunk => chunk.repositoryId));
  const valuesById = new Map(result.map(row => [row.repositoryId, row]));
  return {
    kind: kind.trim(),
    ...(name === undefined ? {} : { name: name.trim() }),
    values: context.visibleRepos.map(repo => {
      const row = valuesById.get(repo.id);
      if (row && contentRepoIds.has(repo.id)) return row;
      return {
        repositoryId: repo.id,
        commit: repo.commit,
        accessGroup: repo.accessGroup,
        status: "not_indexed",
        contentStatus: "no_indexed_content",
        known: false,
        values: [],
        missingMeans: "unknown",
      };
    }),
    coverage: {
      repositories: context.visibleRepos.map(repo => {
        const indexed = context.index.repositories.find(row => row.id === repo.id);
        return indexed
          ? publicCoverage({ repositories: [indexed] })[0]
          : {
              repositoryId: repo.id,
              displayName: repo.displayName,
              commit: repo.commit,
              collectedAt: null,
              status: "not_indexed",
              fileCount: 0,
              errors: [],
            };
      }),
      complete: context.visibleRepos.every(repo => {
        const indexed = context.index.repositories.find(row => row.id === repo.id);
        return indexed?.status === "complete" && contentRepoIds.has(repo.id);
      }),
      status: context.visibleRepos.every(repo => {
        const indexed = context.index.repositories.find(row => row.id === repo.id);
        return indexed?.status === "complete" && contentRepoIds.has(repo.id);
      }) ? "complete" : "partial",
      repositoriesWithoutIndexedContent: context.visibleRepos.filter(repo => !contentRepoIds.has(repo.id)).map(repo => repo.id),
    },
    enumeratedRepositoryIds: context.visibleRepos.map(repo => repo.id),
    repositoryIds: context.visibleRepos.map(repo => repo.id),
    resultCount: context.visibleRepos.length,
  };
}

export async function resolveApplication(context, { query }) {
  if (typeof query !== "string" || !query.trim() || query.length > 500) {
    throwHttp(400, "INVALID_APPLICATION", "query must be a non-empty application name or identifier.");
  }
  const folded = query.trim().toLocaleLowerCase("en-US");
  const allowedIds = new Set(context.visibleRepos.map(repo => repo.id));
  const apps = context.config.applications.filter(app =>
    app.status === "approved" && app.repositoryIds.every(id => allowedIds.has(id)) &&
    (app.id.toLocaleLowerCase("en-US") === folded || app.name.toLocaleLowerCase("en-US") === folded));
  if (apps.length !== 1) throwHttp(404, "NOT_FOUND", "Application mapping not found.");
  const app = apps[0];
  const repositoryById = new Map(context.visibleRepos.map(repo => [repo.id, repo]));
  const indexedById = new Map(context.index.repositories.map(repo => [repo.id, repo]));
  const repositories = app.repositoryIds.map(id => {
    const configured = repositoryById.get(id);
    const indexed = indexedById.get(id);
    return {
      id,
      displayName: configured.displayName,
      commit: configured.commit,
      status: indexed?.commit === configured.commit ? indexed.status : "not_indexed",
    };
  });
  return {
    application: app,
    mappingSource: "human-approved operator configuration",
    inferenceUsed: false,
    repositoryIds: app.repositoryIds,
    repositories,
    coverage: {
      complete: repositories.every(repo => repo.status === "complete"),
      status: repositories.every(repo => repo.status === "complete") ? "complete" : "partial",
    },
    resultCount: 1,
  };
}

export async function runSearch(token, db, input, configFile) {
  return runAuthorized({ token, db, action: "search", configFile, operation: context => searchRepositories(context, input) });
}

export async function runProfile(token, db, input, configFile) {
  return runAuthorized({ token, db, action: "profile", configFile, operation: context => getRepositoryProfile(context, input) });
}

export async function runCompare(token, db, input, configFile) {
  return runAuthorized({ token, db, action: "compare", configFile, operation: context => compareRepositoryFact(context, input) });
}

export async function runResolveApplication(token, db, input, configFile) {
  return runAuthorized({
    token, db, action: "resolve_application", configFile, allowWithoutIndex: true,
    operation: context => resolveApplication(context, input),
  });
}

export function makeIndexFromConfigApplications(index, config) {
  const indexedIds = new Set(index.repositories.map(repo => repo.id));
  return {
    ...index,
    applications: config.applications.filter(app => app.repositoryIds.every(id => indexedIds.has(id))).map(app => ({
      id: app.id,
      name: app.name,
      repositoryIds: [...app.repositoryIds],
      status: app.status,
      reviewedBy: app.reviewedBy ?? null,
      reviewedAt: app.reviewedAt ?? null,
    })),
  };
}

export function mergeIndexes(current, incoming, config) {
  const incomingIds = new Set(incoming.repositories.map(repo => repo.id));
  const repositories = [...(current?.repositories ?? []).filter(repo => !incomingIds.has(repo.id)), ...incoming.repositories];
  const facts = [...(current?.facts ?? []).filter(fact => !incomingIds.has(fact.repositoryId)), ...incoming.facts];
  const chunks = [...(current?.chunks ?? []).filter(chunk => !incomingIds.has(chunk.repositoryId)), ...incoming.chunks];
  const merged = makeIndexFromConfigApplications({
    schemaVersion: "1.0",
    generatedAt: incoming.generatedAt,
    repositories,
    applications: [],
    facts,
    chunks,
    warnings: [...new Set([...(current?.warnings ?? []), ...(incoming.warnings ?? [])])],
  }, config);
  return validateIndex(merged);
}

export async function importCanonicalIndex({ rawIndex, db, configFile, config: suppliedConfig }) {
  const config = suppliedConfig ?? await loadConfig(configFile);
  if (!config.approved) throwHttp(403, "SOURCE_ACCESS_NOT_APPROVED", "Operator has not approved source access.");
  const candidate = await verifyIndexEvidence(rawIndex, config);
  const merged = mergeIndexes(readIndex(db), candidate, config);
  const latestConfig = await loadConfig(configFile);
  if (!latestConfig.approved || JSON.stringify(latestConfig) !== JSON.stringify(config)) {
    throwHttp(403, "AUTHORIZATION_CHANGED", "Operator source approval changed during import.");
  }
  writeIndex(db, merged);
  return { importedRepositoryIds: candidate.repositories.map(repo => repo.id), repositoryStatuses: publicCoverage(candidate) };
}

export async function runAdminAuthorized({ token, db, action, configFile, operation }) {
  const config = await loadConfig(configFile);
  const persona = authenticate(config, token);
  if (!persona?.admin) throwHttp(403, "ADMIN_REQUIRED", "Administrator authorization required.");
  audit(db, persona.id, action, "started");
  try {
    const result = await operation(config);
    const latest = await loadConfig(configFile);
    const currentPersona = authenticate(latest, token);
    if (!currentPersona?.admin || currentPersona.id !== persona.id || !latest.approved) {
      throwHttp(403, "AUTHORIZATION_CHANGED", "Administrator or source approval changed while the request was running.");
    }
    audit(db, persona.id, action, "succeeded", result?.resultCount ?? null);
    return result;
  } catch (error) {
    audit(db, persona.id, action, "failed");
    throw error;
  }
}

export async function enqueueIngestion({ db, configFile, repositoryIds, config: suppliedConfig }) {
  const config = suppliedConfig ?? await loadConfig(configFile);
  if (!config.approved) throwHttp(403, "SOURCE_ACCESS_NOT_APPROVED", "Operator has not approved source access.");
  if (!Array.isArray(repositoryIds) || !repositoryIds.length || repositoryIds.some(id => typeof id !== "string")) {
    throwHttp(400, "INVALID_REPOSITORIES", "repositoryIds must contain one or more configured repository identifiers.");
  }
  const unique = [...new Set(repositoryIds)];
  const byId = new Map(config.repositories.map(repo => [repo.id, repo]));
  if (unique.some(id => !byId.get(id)?.approved)) throwHttp(404, "NOT_FOUND", "Repository not found.");
  const now = new Date().toISOString();
  const insert = db.prepare("INSERT INTO ingestion_jobs(id, repo_id, commit_sha, access_group, include_paths_json, state, created_at, updated_at) VALUES(?,?,?,?,?,'queued',?,?)");
  const jobs = unique.map(repoId => {
    const spec = byId.get(repoId);
    const id = randomUUID();
    insert.run(id, repoId, spec.commit, spec.accessGroup, JSON.stringify(spec.includePaths), now, now);
    return { id, repositoryId: repoId, commit: spec.commit, state: "queued" };
  });
  return { jobs };
}

export async function processNextIngestionJob({ db, configFile, token, config: suppliedConfig }) {
  const config = suppliedConfig ?? await loadConfig(configFile);
  const persona = authenticate(config, token);
  if (!config.approved || !persona?.admin) throwHttp(403, "ADMIN_REQUIRED", "Administrator authorization and explicit source approval are required.");
  const job = db.prepare("SELECT id, repo_id, commit_sha, access_group, include_paths_json FROM ingestion_jobs WHERE state='queued' ORDER BY created_at LIMIT 1").get();
  if (!job) return null;
  audit(db, persona.id, "ingestion_worker", "started");
  const now = new Date().toISOString();
  const claimed = db.prepare("UPDATE ingestion_jobs SET state='running', updated_at=? WHERE id=? AND state='queued'").run(now, job.id);
  if (!claimed.changes) return null;
  try {
    const spec = config.repositories.find(repo => repo.id === job.repo_id && repo.approved &&
      repo.commit === job.commit_sha && repo.accessGroup === job.access_group &&
      JSON.stringify(repo.includePaths) === job.include_paths_json);
    if (!spec) throw new Error("Queued repository is no longer approved at its pinned commit.");
    const { stdout: resolved } = await execFile("git", ["-C", spec.checkout, "rev-parse", "--verify", `${spec.commit}^{commit}`], {
      encoding: "utf8", windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1" },
    });
    if (resolved.trim() !== spec.commit) throw new Error("Configured commit is not an exact commit object in the approved checkout.");
    // Ignoring the option would scan the whole tree, so refuse before any blob read.
    if (!String(ingestRepositories).includes("includePaths")) {
      const error = new Error("The shared core cannot enforce repository path allowlists; collection was refused.");
      error.code = "CORE_PATH_FILTER_UNSUPPORTED";
      throw error;
    }
    const ingested = await ingestRepositories([{
      id: spec.id,
      displayName: spec.displayName,
      checkout: spec.checkout,
      commit: spec.commit,
      accessGroup: spec.accessGroup,
      includePaths: spec.includePaths,
    }], { includePaths: spec.includePaths });
    const verified = await verifyIndexEvidence(ingested, config);
    const merged = mergeIndexes(readIndex(db), verified, config);
    const current = suppliedConfig ?? await loadConfig(configFile);
    const currentPersona = authenticate(current, token);
    if (!current.approved || !currentPersona?.admin || currentPersona.id !== persona.id ||
        JSON.stringify(current) !== JSON.stringify(config) || !current.repositories.some(repo =>
          repo.id === spec.id && repo.commit === spec.commit && repo.accessGroup === spec.accessGroup &&
          JSON.stringify(repo.includePaths) === job.include_paths_json && repo.approved)) {
      throw new Error("Repository approval changed during ingestion; results were not stored.");
    }
    writeIndex(db, merged);
    db.prepare("UPDATE ingestion_jobs SET state='succeeded', updated_at=?, error_code=NULL, error_message=NULL WHERE id=?")
      .run(new Date().toISOString(), job.id);
    audit(db, persona.id, "ingestion_worker", "succeeded", 1);
  } catch (error) {
    const code = error.code === "CORE_PATH_FILTER_UNSUPPORTED" ? "CORE_PATH_FILTER_UNSUPPORTED" : "INGESTION_FAILED";
    const message = code === "CORE_PATH_FILTER_UNSUPPORTED"
      ? "Shared-core path allowlist support is required; no source collection occurred."
      : "Source collection failed; inspect operator configuration and local checkout.";
    db.prepare("UPDATE ingestion_jobs SET state='failed', updated_at=?, error_code=?, error_message=? WHERE id=?")
      .run(new Date().toISOString(), code, message, job.id);
    audit(db, persona.id, "ingestion_worker", "failed");
  }
  return db.prepare("SELECT id, repo_id AS repositoryId, commit_sha AS pinnedCommit, state, error_code AS errorCode, error_message AS errorMessage FROM ingestion_jobs WHERE id=?").get(job.id);
}

export async function importIndexFile(file, options) {
  let metadata;
  try {
    metadata = await stat(file);
  } catch (error) {
    throwHttp(400, "INVALID_INDEX_FILE", `Index file could not be read: ${error.message}`);
  }
  if (metadata.size > 25 * 1024 * 1024) {
    throwHttp(413, "INDEX_TOO_LARGE", "Canonical index JSON exceeds the 25 MiB limit.");
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throwHttp(400, "INVALID_INDEX_JSON", `Index file could not be parsed: ${error.message}`);
  }
  return importCanonicalIndex({ ...options, rawIndex: parsed });
}
