import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { validateIndex } from "../core/index.mjs";
import { isAllowedRepoPath } from "./path-allowlist.mjs";

const execFile = promisify(execFileCallback);
const sha = /^[a-f0-9]{40}$/;

function safeRepoPath(file) {
  return typeof file === "string" && file.length > 0 && !file.startsWith("/") &&
    !file.includes("\\") && !file.includes("\0") &&
    file.split("/").every(part => part && part !== "." && part !== ".." && !part.includes(":"));
}

async function git(checkout, args, maxBuffer = 8 * 1024 * 1024) {
  return execFile("git", ["-C", checkout, ...args], {
    encoding: "buffer",
    maxBuffer,
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1" },
  });
}

export async function verifyIndexEvidence(rawIndex, config) {
  const index = validateIndex(rawIndex);
  if (!config.approved) throw new Error("Operator has not approved source access.");
  const repoById = new Map(config.repositories.filter(repo => repo.approved).map(repo => [repo.id, repo]));
  const indexedRepos = new Map(index.repositories.map(repo => [repo.id, repo]));
  for (const repo of index.repositories) {
    const source = repoById.get(repo.id);
    if (!source || source.commit !== repo.commit || source.accessGroup !== repo.accessGroup) {
      throw new Error(`Repository "${repo.id}" is not approved at the exact indexed commit and access group.`);
    }
    const { stdout } = await git(source.checkout, ["rev-parse", "--verify", `${repo.commit}^{commit}`], 1024 * 1024);
    if (stdout.toString("utf8").trim() !== repo.commit) throw new Error(`Commit verification failed for repository "${repo.id}".`);
  }
  const blobs = new Map();
  async function sourceLines(repositoryId, commit, file, blobSha) {
    const sourceSpec = repoById.get(repositoryId);
    if (!safeRepoPath(file) || !sourceSpec || !isAllowedRepoPath(file, sourceSpec.includePaths)) {
      throw new Error("Evidence path is unsafe or outside the approved repository path allowlist.");
    }
    const repo = indexedRepos.get(repositoryId);
    const source = repoById.get(repositoryId);
    if (!repo || !source || repo.commit !== commit || source.commit !== commit || !sha.test(blobSha)) {
      throw new Error("Evidence does not resolve to an approved repository commit.");
    }
    const key = `${repositoryId}\0${file}\0${blobSha}`;
    if (blobs.has(key)) return blobs.get(key);
    const { stdout: resolved } = await git(source.checkout, ["rev-parse", "--verify", `${commit}:${file}`], 1024 * 1024);
    if (resolved.toString("utf8").trim() !== blobSha) throw new Error(`Blob SHA mismatch for repository "${repositoryId}".`);
    const { stdout } = await git(source.checkout, ["cat-file", "blob", blobSha], 4 * 1024 * 1024);
    const text = stdout.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(stdout) || text.includes("\0")) {
      throw new Error(`Non-text evidence is not accepted for repository "${repositoryId}".`);
    }
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    if (lines.at(-1) === "") lines.pop();
    blobs.set(key, lines);
    return lines;
  }
  for (const chunk of index.chunks) {
    const lines = await sourceLines(chunk.repositoryId, chunk.commit, chunk.path, chunk.blobSha);
    if (chunk.endLine > lines.length) throw new Error("Chunk line range exceeds the source blob.");
    const expected = lines.slice(chunk.startLine - 1, chunk.endLine).join("\n");
    if (chunk.text !== expected) throw new Error(`Chunk text does not match the cited Git lines in repository "${chunk.repositoryId}".`);
  }
  for (const fact of index.facts) {
    for (const evidence of fact.evidence) {
      const lines = await sourceLines(fact.repositoryId, fact.commit, evidence.path, evidence.blobSha);
      if (evidence.endLine > lines.length) throw new Error("Fact citation line range exceeds the source blob.");
    }
  }
  return index;
}
