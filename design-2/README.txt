Design 2 — local, commit-pinned repository knowledge service
=============================================================

This is a deterministic local API and Model Context Protocol (MCP) server over
the shared ../core/index.mjs implementation. It does not contain a demo index,
sample answers, source repositories, an LLM, or external dependencies. Source
text is stored in the local SQLite index and returned only to an authorized
persona with citations. Results identify the repository, exact 40-character
commit, path, line range, and Git blob SHA. Searches return all matches, not a
top-K presented as complete. If an explicitly configured shared-core result
ceiling is ever reached, matched/returned counts and truncation are reported
with partial status, never as a complete answer. Missing fact evidence means
unknown.
Retrieved source text is untrusted data, never instructions to the MCP server or
the caller's model.

Requirements
------------

Use Node.js 24 or newer and Git. No npm install is needed. This service makes
no GitHub/remote requests, performs no OAuth/PAT flow, fetches no objects, runs
no repository code, and installs no repository dependencies.

Explicit local operator approval
--------------------------------

Nothing reads source until an operator has:
  1. Copied config.example.json to config.json:
       Copy-Item .\config.example.json .\config.json
  2. Entered an absolute local checkout, exact commit SHA, repository ID,
     display name, accessGroup, and approved:true for each source.
  3. Set the top-level approved flag to true after approving those paths and
     groups.
  4. Configured persona token hashes and group allowlists.

Keep config.json private; it is ignored by git. Local personas authenticate with
a bearer token whose SHA-256 hash is in the config. The server intersects the
persona's accessGroups with each indexed repository's accessGroup. Request
repository IDs can only narrow an already-authorized search; they never grant
access. Unauthorized repository IDs and missing records return the same
not-found response. There is no shared result cache.

Generate a random persona token in PowerShell without saving it to this folder:

  $token = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
  $token | node .\cli.mjs hash-token

Put only the displayed hash in the appropriate `tokenSha256` field in
config.json, and retain `$token` in your protected shell session. Do not put a
real token in source control, command-line arguments, or logs. Configure
separate least-privilege personas for routine searches and administrators.

To approve a local checkout, resolve and review its current commit explicitly:

  git -C 'C:\approved\repository' rev-parse HEAD

Copy config.example.json to config.json and edit it. A repository entry has this
shape (replace every placeholder; this is configuration syntax, not a bundled
repository):

  {
    "id": "repo-id",
    "displayName": "Reviewed repository name",
    "checkout": "C:\\approved\\repository",
    "commit": "40-lowercase-hex-characters-from-rev-parse",
    "accessGroup": "engineering-readers",
    "includePaths": ["README.md", "src/**/*.py"],
    "approved": true
  }

Set `approved:true` at the root only after reviewing all configured source
paths and access groups. `includePaths` is mandatory, repository-relative, and
supports `*`, `**`, and `?`; ingestion and index import must remain within this
allowlist. The service rejects branch names, abbreviated SHAs,
missing checkouts, and unapproved repo entries. The `applications` array is
optional human-maintained mapping data; set status to `approved` only after
human review. A repository is never implicitly an application.

Ingest or import
----------------

Run commands from this directory.

Queue an exact-commit local ingestion as an administrator:

  $env:SCOUT_PERSONA_TOKEN = $token
  node .\cli.mjs enqueue repo-id
  node .\cli.mjs worker

`worker` handles one queued job. Successful jobs record the actual core
ingestion result. Failed jobs are marked failed with a safe generic diagnostic;
they are never represented as collected. The queue is durable in SQLite.
The worker refuses to read any source if the shared core does not implement
the configured `includePaths` filter before blob reads.
Inspect a job from the local API at
`GET /v1/admin/ingestion-jobs/{job-id}` with the admin bearer token.

Alternatively, import the canonical Design 1 index only after the same
repository IDs, exact commits, and access groups have been explicitly approved
in config.json:

  node .\cli.mjs import-index 'C:\path\to\design1-index.json'

Import validates the shared schema and fact/chunk relationships, resolves each
commit and cited path in the approved local checkout, checks exact blob hashes
and line bounds, and verifies chunk text against its cited Git lines. Index
application mappings are replaced by the operator-maintained config mappings.
An incomplete/partial source stays incomplete/partial.

Local HTTP API
--------------

  node .\api.mjs

It binds only to 127.0.0.1 (default port 8765; override with PORT). It does not
enable CORS and rejects browser-origin requests. Endpoints:

  GET  /health
  GET  /v1/repositories
  POST /v1/search                 {"query":"exact phrase or lexical terms"}
  GET  /v1/repositories/{id}/profile
  POST /v1/compare                {"kind":"fact kind","name":"optional name"}
  POST /v1/applications/resolve   {"query":"human-configured application"}
  POST /v1/admin/import           canonical index JSON body
  POST /v1/admin/ingestion-jobs  {"repositoryIds":["repo-id"]}
  GET  /v1/admin/ingestion-jobs/{job-id}

Use `Authorization: Bearer <persona-token>` for every endpoint other than
/health. JSON responses use no-store. Audit records contain persona ID, action,
time, outcome, and count only—not query text, source text, or credentials. API
errors explicitly distinguish 503 `NO_INDEXED_CONTENT`, a successful
`no_exact_match`, and HTTP 206 `PARTIAL_COVERAGE` with bounded results and
per-repository coverage. MCP marks partial tool results `isError:true` while
retaining their structured coverage. Collection warnings and
unsupported/excluded file counts remain visible.

MCP stdio server and Copilot
----------------------------

Run `node .\mcp.mjs` as a stdio child process. Stdout is reserved for newline-
delimited JSON-RPC; diagnostics go to stderr. It implements MCP initialize,
ping, tools/list, tools/call, and the notifications needed for a normal
stdio-tools session. The four tools are:

  search_repository_code
  get_repository_profile
  compare_repository_fact
  resolve_application

For VS Code Copilot, add this server entry to the consuming workspace's
`.vscode/mcp.json` (do not place tokens directly in the file). Configure the
prompt input to provide a token at launch:

  {
    "inputs": [{
      "type": "promptString",
      "id": "engineeringPersonaToken",
      "description": "Local engineering knowledge persona token",
      "password": true
    }],
    "servers": {
      "engineering-knowledge": {
        "type": "stdio",
        "command": "node",
        "args": ["C:\\path\\to\\engineering-knowledge-service\\design-2\\mcp.mjs"],
        "env": {
          "SCOUT_PERSONA_TOKEN": "${input:engineeringPersonaToken}",
          "SCOUT_ENGINE_CONFIG": "C:\\path\\to\\engineering-knowledge-service\\design-2\\config.json"
        }
      }
    }
  }

The Copilot client supplies its own LLM under the user's normal Copilot
account/tenant policies; this deterministic MCP server does not pretend to call
Foundry or inherit the user's GitHub authorization. MCP access is controlled by
the configured local persona and is not a substitute for the Copilot
account's permissions. Do not configure the process for untrusted users.

Production boundary and limitations
------------------------------------

This folder is a local development implementation, not a production identity
system or Azure deployment. For production, use either a GitHub App with
per-user repository authorization, or a repository-bound service identity
with explicit Microsoft Entra scopes. Azure RBAC alone does not establish
per-repository/user authorization. Recheck ACLs before and after work, maintain
an immutable collection commit, and keep model inference in the Copilot user's
approved client boundary. This service has no GitHub App, Entra integration,
Foundry endpoint, production credentials, or deployed cloud resources.

azure/production-boundary.bicep contains no resources and cannot provision the
service; it is an architecture placeholder, not a deployable service template.
azure/production-auth.schema.json describes required production identity
choices only; it is not wired into runtime and does not certify a deployment.

No organization-specific repositories, source-derived indexes, or answer sets
are bundled. Configure only sources and audiences approved by their owners.
No Azure/Foundry inference or production authentication has been exercised.

Validation
----------

  npm test

Tests create and remove local temporary Git repositories under this folder;
they do not bundle a source fixture or install packages.

Unit tests create temporary Git repositories from generated fixture content.
They do not access external repositories or bundle a source index.
