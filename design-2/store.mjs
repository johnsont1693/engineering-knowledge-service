import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export async function openStore(file = process.env.SCOUT_ENGINE_DB ?? path.join(import.meta.dirname, "data", "index.sqlite")) {
  await mkdir(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS knowledge_index (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      index_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ingestion_jobs (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      commit_sha TEXT NOT NULL,
      access_group TEXT NOT NULL,
      include_paths_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('queued','running','succeeded','failed')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      error_code TEXT,
      error_message TEXT
    );
    CREATE INDEX IF NOT EXISTS ingestion_jobs_state ON ingestion_jobs(state, created_at);
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      persona_id TEXT NOT NULL,
      action TEXT NOT NULL,
      result_count INTEGER,
      outcome TEXT NOT NULL
    );
  `);
  return db;
}

export function readIndex(db) {
  const row = db.prepare("SELECT index_json FROM knowledge_index WHERE singleton = 1").get();
  return row ? JSON.parse(row.index_json) : null;
}

export function writeIndex(db, index) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO knowledge_index(singleton, schema_version, generated_at, index_json, updated_at)
    VALUES(1, ?, ?, ?, ?)
    ON CONFLICT(singleton) DO UPDATE SET schema_version=excluded.schema_version,
      generated_at=excluded.generated_at, index_json=excluded.index_json, updated_at=excluded.updated_at`)
    .run(index.schemaVersion, index.generatedAt, JSON.stringify(index), now);
}

export function audit(db, personaId, action, outcome, resultCount = null) {
  db.prepare("INSERT INTO audit_log(at, persona_id, action, result_count, outcome) VALUES(?,?,?,?,?)")
    .run(new Date().toISOString(), personaId, action, resultCount, outcome);
}
