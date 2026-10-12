import { readFile } from "node:fs/promises";
import { createHash, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { compileRepoPathPattern } from "./path-allowlist.mjs";

const idPattern = /^[A-Za-z0-9._-]+$/;
const shaPattern = /^[a-f0-9]{40}$/;

export async function loadConfig(file = process.env.SCOUT_ENGINE_CONFIG ?? path.join(import.meta.dirname, "config.json")) {
  let config;
  try {
    config = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`Operator config not found at ${file}; copy config.example.json, explicitly approve repositories, and configure personas.`);
    throw new Error(`Cannot load operator config: ${error.message}`);
  }
  validateConfig(config);
  return config;
}

export function validateConfig(config) {
  if (!config || config.version !== 1 || typeof config.approved !== "boolean" ||
      !Array.isArray(config.repositories) || !Array.isArray(config.personas) ||
      !Array.isArray(config.applications ?? [])) {
    throw new Error("Invalid operator config: expected version 1, approval state, repositories, personas, and applications.");
  }
  const repoIds = new Set();
  for (const repo of config.repositories) {
    if (!idPattern.test(repo.id ?? "") || repoIds.has(repo.id) ||
        typeof repo.displayName !== "string" || !repo.displayName.trim() ||
        typeof repo.checkout !== "string" || !path.isAbsolute(repo.checkout) ||
        !shaPattern.test(repo.commit ?? "") || typeof repo.accessGroup !== "string" || !repo.accessGroup.trim() ||
        !Array.isArray(repo.includePaths) || !repo.includePaths.length || repo.includePaths.length > 100 ||
        repo.approved !== true) {
      throw new Error(`Invalid or unapproved repository config for "${repo.id ?? "unknown"}"; require unique id, absolute checkout, full commit SHA, accessGroup, displayName, approved:true, and explicit includePaths.`);
    }
    for (const pattern of repo.includePaths) {
      if (typeof pattern !== "string" || pattern.length > 512 || pattern.trim() !== pattern || /[\[\]{}]/u.test(pattern)) {
        throw new Error(`Invalid repository path allowlist pattern for "${repo.id}".`);
      }
      compileRepoPathPattern(pattern);
    }
    repoIds.add(repo.id);
  }
  const personaIds = new Set();
  const personaTokens = new Set();
  for (const persona of config.personas) {
    if (typeof persona.id !== "string" || !idPattern.test(persona.id) || personaIds.has(persona.id) ||
        !/^[a-f0-9]{64}$/.test(persona.tokenSha256 ?? "") ||
        personaTokens.has(persona.tokenSha256) ||
        !Array.isArray(persona.accessGroups) || persona.accessGroups.some(group => typeof group !== "string") ||
        typeof persona.admin !== "boolean") {
      throw new Error(`Invalid persona config for "${persona.id ?? "unknown"}".`);
    }
    personaIds.add(persona.id);
    personaTokens.add(persona.tokenSha256);
  }
  const applicationIds = new Set();
  for (const application of config.applications ?? []) {
    if (!idPattern.test(application.id ?? "") || typeof application.name !== "string" ||
        !Array.isArray(application.repositoryIds) || application.repositoryIds.length === 0 ||
        new Set(application.repositoryIds).size !== application.repositoryIds.length ||
        applicationIds.has(application.id) ||
        application.repositoryIds.some(id => !repoIds.has(id)) ||
        !["draft", "approved"].includes(application.status)) {
      throw new Error(`Invalid human-configured application mapping "${application.id ?? "unknown"}".`);
    }
    applicationIds.add(application.id);
  }
  return config;
}

export function hashToken(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function authenticate(config, token) {
  if (!config.approved || typeof token !== "string" || !token) return null;
  const candidate = Buffer.from(hashToken(token), "hex");
  for (const persona of config.personas) {
    const expected = Buffer.from(persona.tokenSha256, "hex");
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) return persona;
  }
  return null;
}

export function authorizedRepositories(config, persona, index) {
  const configured = new Map(config.repositories.map(repo => [repo.id, repo]));
  return index.repositories.filter(repo => {
    const source = configured.get(repo.id);
    return source?.approved === true && source.commit === repo.commit && source.accessGroup === repo.accessGroup &&
      persona.accessGroups.includes(repo.accessGroup);
  });
}

export function personaConfiguredRepositories(config, persona) {
  return config.repositories.filter(repo =>
    repo.approved === true && persona.accessGroups.includes(repo.accessGroup));
}

export function authorizedIndex(config, persona, index) {
  const repositories = authorizedRepositories(config, persona, index);
  const ids = new Set(repositories.map(repo => repo.id));
  return {
    ...index,
    repositories,
    facts: index.facts.filter(fact => ids.has(fact.repositoryId)),
    chunks: index.chunks.filter(chunk => ids.has(chunk.repositoryId)),
    applications: (index.applications ?? []).filter(app =>
      app.status === "approved" && app.repositoryIds.every(id => ids.has(id))),
  };
}
