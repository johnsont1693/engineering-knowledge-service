import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashToken } from "../config.mjs";
import { openStore, readIndex, writeIndex } from "../store.mjs";
import { ingestRepositories } from "../../core/index.mjs";
import { mergeIndexes, runSearch, runProfile, runCompare, runResolveApplication, enqueueIngestion, processNextIngestionJob } from "../engine.mjs";
import { startApi } from "../api.mjs";
import { verifyIndexEvidence } from "../evidence.mjs";
import { loadConfig } from "../config.mjs";
import { isAllowedRepoPath } from "../path-allowlist.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".test-workspace");
const configFile = path.join(root, "config.json");
const dbFile = path.join(root, "test.sqlite");
const tokens = { admin: "test-admin-token-never-for-production", reader: "test-reader-token-never-for-production" };
let db;
let specA;
let specB;

function git(checkout, ...args) {
  return execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8", windowsHide: true });
}

async function createRepository(id, group, heading, body) {
  const checkout = path.join(root, id);
  await mkdir(checkout, { recursive: true });
  await writeFile(path.join(checkout, "README.md"), `# ${heading}\n\n${body}\n`, "utf8");
  git(checkout, "init", "--quiet");
  git(checkout, "config", "user.name", "Test Operator");
  git(checkout, "config", "user.email", "test@example.invalid");
  git(checkout, "config", "core.autocrlf", "false");
  git(checkout, "add", "README.md");
  git(checkout, "commit", "--quiet", "-m", "fixture source");
  const commit = git(checkout, "rev-parse", "HEAD").trim();
  return { id, displayName: heading, checkout, commit, accessGroup: group, includePaths: ["README.md"], approved: true };
}

before(async () => {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  specA = await createRepository("repo-alpha", "group-a", "Service Alpha", "Approved review checks the release path.");
  specB = await createRepository("repo-beta", "group-b", "Service Beta", "Approved review checks the deployment path.");
  const config = {
    version: 1,
    approved: true,
    repositories: [specA, specB],
    personas: [
      { id: "admin", tokenSha256: hashToken(tokens.admin), accessGroups: ["group-a", "group-b"], admin: true },
      { id: "reader-a", tokenSha256: hashToken(tokens.reader), accessGroups: ["group-a"], admin: false },
    ],
    applications: [{
      id: "review-platform",
      name: "Review Platform",
      repositoryIds: ["repo-alpha", "repo-beta"],
      status: "approved",
      reviewedBy: "test operator",
      reviewedAt: new Date().toISOString(),
    }],
  };
  await writeFile(configFile, JSON.stringify(config), "utf8");
  process.env.SCOUT_ENGINE_CONFIG = configFile;
  process.env.SCOUT_ENGINE_DB = dbFile;
  db = await openStore(dbFile);
  let index = null;
  for (const spec of [specA, specB]) {
    const ingested = ingestRepositories([{
      id: spec.id,
      displayName: spec.displayName,
      checkout: spec.checkout,
      commit: spec.commit,
      accessGroup: spec.accessGroup,
      includePaths: spec.includePaths,
    }], { includePaths: spec.includePaths });
    index = mergeIndexes(index, ingested, config);
  }
  writeIndex(db, index);
});

after(async () => {
  db?.close();
  delete process.env.SCOUT_ENGINE_CONFIG;
  delete process.env.SCOUT_ENGINE_DB;
  await rm(root, { recursive: true, force: true });
});

test("search returns all authorized commit-pinned matches and coverage", async () => {
  const result = await runSearch(tokens.admin, db, { query: '"approved review"' }, configFile);
  assert.equal(result.answerStatus, "matches_found");
  assert.equal(result.results.length, 2);
  assert.equal(result.coverage.repositories[0].commit, specA.commit);
  assert.equal(result.coverage.repositories[1].commit, specB.commit);
  for (const match of result.results) {
    assert.equal(match.path, "README.md");
    assert.match(match.commit, /^[a-f0-9]{40}$/);
    assert.match(match.blobSha, /^[a-f0-9]{40}$/);
    assert.ok(match.startLine > 0 && match.endLine >= match.startLine);
  }
});

test("persona group intersection is applied before search, comparison, and application resolution", async () => {
  const result = await runSearch(tokens.reader, db, { query: "approved review" }, configFile);
  assert.deepEqual(result.repositoryIds, ["repo-alpha"]);
  assert.equal(result.results.length, 1);
  await assert.rejects(runSearch(tokens.reader, db, {
    query: "approved review",
    repositoryIds: ["repo-beta"],
  }, configFile), error => error.status === 404 && error.message === "Repository not found.");
  const comparison = await runCompare(tokens.reader, db, { kind: "document.heading" }, configFile);
  assert.deepEqual(comparison.enumeratedRepositoryIds, ["repo-alpha"]);
  assert.equal(comparison.values.length, 1);
  await assert.rejects(runResolveApplication(tokens.reader, db, { query: "Review Platform" }, configFile),
    error => error.status === 404);
});

test("profile, exhaustive unknowns, and only human-configured application mappings are returned", async () => {
  const profile = await runProfile(tokens.admin, db, { repositoryId: "repo-alpha" }, configFile);
  assert.equal(profile.repository.commit, specA.commit);
  assert.ok(profile.facts.some(fact => fact.citations.some(citation => citation.path === "README.md")));
  const comparison = await runCompare(tokens.admin, db, { kind: "not-collected-kind" }, configFile);
  assert.deepEqual(comparison.enumeratedRepositoryIds, ["repo-alpha", "repo-beta"]);
  assert.ok(comparison.values.every(row => row.known === false && row.missingMeans === "unknown"));
  const application = await runResolveApplication(tokens.admin, db, { query: "Review Platform" }, configFile);
  assert.equal(application.mappingSource, "human-approved operator configuration");
  assert.equal(application.repositories.length, 2);
  await assert.rejects(runResolveApplication(tokens.admin, db, { query: "repo-alpha" }, configFile),
    error => error.status === 404);
});

test("absence of any indexed source chunks is an explicit service error", async () => {
  const emptyDb = await openStore(":memory:");
  try {
    const index = readIndex(db);
    writeIndex(emptyDb, {
      ...index,
      repositories: index.repositories.map(repo => ({ ...repo, fileCount: 0 })),
      facts: [],
      chunks: [],
    });
    await assert.rejects(runSearch(tokens.admin, emptyDb, { query: "anything" }, configFile),
      error => error.status === 503 && error.code === "NO_INDEXED_CONTENT");
    await assert.rejects(runCompare(tokens.admin, emptyDb, { kind: "anything" }, configFile),
      error => error.status === 503 && error.code === "NO_INDEXED_CONTENT");
    await assert.rejects(runProfile(tokens.admin, emptyDb, { repositoryId: "repo-alpha" }, configFile),
      error => error.status === 503 && error.code === "NO_INDEXED_CONTENT");
  } finally {
    emptyDb.close();
  }
});

test("unindexed but authorized repositories remain visible as unknown coverage, not omitted", async () => {
  const fullIndex = readIndex(db);
  const subset = {
    ...fullIndex,
    repositories: fullIndex.repositories.filter(repo => repo.id === "repo-alpha"),
    applications: [],
    facts: fullIndex.facts.filter(fact => fact.repositoryId === "repo-alpha"),
    chunks: fullIndex.chunks.filter(chunk => chunk.repositoryId === "repo-alpha"),
    warnings: fullIndex.warnings.filter(warning => warning.startsWith("repo-alpha:")),
  };
  writeIndex(db, subset);
  try {
    const search = await runSearch(tokens.admin, db, { query: "approved review" }, configFile);
    assert.equal(search.results.length, 1);
    assert.deepEqual(search.coverage.repositoriesWithoutIndexedContent, ["repo-beta"]);
    assert.equal(search.status, "partial");
    const compare = await runCompare(tokens.admin, db, { kind: "document.heading" }, configFile);
    assert.deepEqual(compare.enumeratedRepositoryIds, ["repo-alpha", "repo-beta"]);
    assert.equal(compare.values.find(row => row.repositoryId === "repo-beta").known, false);
    assert.equal(compare.values.find(row => row.repositoryId === "repo-beta").status, "not_indexed");
    await assert.rejects(runProfile(tokens.admin, db, { repositoryId: "repo-beta" }, configFile),
      error => error.status === 503 && error.code === "NO_INDEXED_CONTENT");
    const app = await runResolveApplication(tokens.admin, db, { query: "Review Platform" }, configFile);
    assert.equal(app.repositories.find(repo => repo.id === "repo-beta").status, "not_indexed");
    await assert.rejects(runResolveApplication(tokens.reader, db, { query: "Review Platform" }, configFile),
      error => error.status === 404);
  } finally {
    writeIndex(db, fullIndex);
  }
  const emptyDb = await openStore(":memory:");
  try {
    const mapping = await runResolveApplication(tokens.admin, emptyDb, { query: "Review Platform" }, configFile);
    assert.ok(mapping.repositories.every(repo => repo.status === "not_indexed"));
  } finally {
    emptyDb.close();
  }
});

test("durable ingestion queue pins commits and honors configured path filtering", async () => {
  const queued = await enqueueIngestion({ db, configFile, repositoryIds: ["repo-alpha"] });
  assert.equal(queued.jobs[0].commit, specA.commit);
  const completed = await processNextIngestionJob({ db, configFile, token: tokens.admin });
  assert.equal(completed.id, queued.jobs[0].id);
  assert.equal(completed.pinnedCommit, specA.commit);
  if (String(ingestRepositories).includes("includePaths")) {
    assert.equal(completed.state, "succeeded");
  } else {
    assert.equal(completed.state, "failed");
    assert.equal(completed.errorCode, "CORE_PATH_FILTER_UNSUPPORTED");
  }
});

test("index import rejects fabricated chunk text, blob hashes, and unsafe paths", async () => {
  const source = readIndex(db);
  const config = await loadConfig(configFile);
  const forgedText = structuredClone(source);
  forgedText.chunks[0].text += "\nforged";
  await assert.rejects(verifyIndexEvidence(forgedText, config), /Chunk text does not match/);
  const forgedHash = structuredClone(source);
  const originalSha = forgedHash.chunks[0].blobSha;
  forgedHash.chunks[0].blobSha = "f".repeat(40);
  for (const fact of forgedHash.facts) {
    for (const citation of fact.evidence) {
      if (citation.blobSha === originalSha && citation.path === forgedHash.chunks[0].path) citation.blobSha = "f".repeat(40);
    }
  }
  await assert.rejects(verifyIndexEvidence(forgedHash, config), /Blob SHA mismatch/);
  const unsafe = structuredClone(source);
  unsafe.chunks[0].path = "../private/secret.md";
  await assert.rejects(verifyIndexEvidence(unsafe, config), /unsafe/);
});

test("explicit path allowlists are repository-relative and glob-scoped", () => {
  const allowed = ["analysis/*.py", "README.md", "requirements/**", "checks/**"];
  assert.equal(isAllowedRepoPath("analysis/model.py", allowed), true);
  assert.equal(isAllowedRepoPath("analysis/nested/model.py", allowed), false);
  assert.equal(isAllowedRepoPath("analysis/nested/model.py", ["analysis/**/*.py"]), true);
  assert.equal(isAllowedRepoPath("analysis/model.py", ["analysis/**/*.py"]), true);
  assert.equal(isAllowedRepoPath("requirements/spec.txt", allowed), true);
  assert.equal(isAllowedRepoPath("../private/secret.py", allowed), false);
  assert.equal(isAllowedRepoPath("tests/test_model.py", allowed), false);
});

test("MCP stdio speaks JSON-RPC and emits only protocol JSON on stdout", () => {
  const mcpFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "mcp.mjs");
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_repository_code", arguments: { query: "approved review" } } },
  ];
  const child = spawnSync(process.execPath, [mcpFile], {
    input: `${messages.map(message => JSON.stringify(message)).join("\n")}\n`,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, SCOUT_PERSONA_TOKEN: tokens.admin, SCOUT_ENGINE_CONFIG: configFile, SCOUT_ENGINE_DB: dbFile },
  });
  assert.equal(child.status, 0, child.stderr);
  const responses = child.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.deepEqual(responses.map(response => response.id), [1, 2, 3]);
  assert.equal(responses[1].result.tools.length, 4);
  const mcpResult = responses[2].result.structuredContent;
  assert.equal(mcpResult.results.length, 2);
  assert.ok(mcpResult.results.every(result => result.commit && result.blobSha));
});

test("HTTP API is loopback-only and serves authorized search", async t => {
  const { server, db: apiDb, address } = await startApi({ port: 0, configFile });
  t.after(() => {
    server.close();
    apiDb.close();
  });
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/search`, {
    method: "POST",
    headers: { authorization: `Bearer ${tokens.reader}`, "content-type": "application/json" },
    body: JSON.stringify({ query: "approved review" }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.repositoryIds, ["repo-alpha"]);
  assert.equal(body.results.length, 1);
  const reposResponse = await fetch(`http://127.0.0.1:${address.port}/v1/repositories`, {
    headers: { authorization: `Bearer ${tokens.reader}` },
  });
  assert.equal(reposResponse.status, 200);
  const repos = await reposResponse.json();
  assert.deepEqual(repos.repositories.map(repo => repo.id), ["repo-alpha"]);
  assert.equal(Object.hasOwn(repos.repositories[0], "remoteUrl"), false);
  const completeIndex = readIndex(db);
  writeIndex(db, {
    ...completeIndex,
    repositories: completeIndex.repositories.filter(repo => repo.id === "repo-alpha"),
    applications: [],
    facts: completeIndex.facts.filter(fact => fact.repositoryId === "repo-alpha"),
    chunks: completeIndex.chunks.filter(chunk => chunk.repositoryId === "repo-alpha"),
    warnings: completeIndex.warnings.filter(warning => warning.startsWith("repo-alpha:")),
  });
  const partial = await fetch(`http://127.0.0.1:${address.port}/v1/search`, {
    method: "POST",
    headers: { authorization: `Bearer ${tokens.admin}`, "content-type": "application/json" },
    body: JSON.stringify({ query: "approved review" }),
  });
  assert.equal(partial.status, 206);
  const partialBody = await partial.json();
  assert.equal(partialBody.error.code, "PARTIAL_COVERAGE");
  assert.deepEqual(partialBody.coverage.repositoriesWithoutIndexedContent, ["repo-beta"]);
  writeIndex(db, completeIndex);
  const imported = await fetch(`http://127.0.0.1:${address.port}/v1/admin/import`, {
    method: "POST",
    headers: { authorization: `Bearer ${tokens.admin}`, "content-type": "application/json" },
    body: JSON.stringify(readIndex(db)),
  });
  assert.equal(imported.status, 200);
  assert.deepEqual((await imported.json()).importedRepositoryIds.sort(), ["repo-alpha", "repo-beta"]);
  const denied = await fetch(`http://127.0.0.1:${address.port}/v1/search`, {
    method: "POST",
    headers: { authorization: `Bearer ${tokens.reader}`, "content-type": "application/json", origin: "http://127.0.0.1" },
    body: JSON.stringify({ query: "approved review" }),
  });
  assert.equal(denied.status, 403);
});
