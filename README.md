# Engineering Knowledge Service (MCP prototype)

Expose approved engineering source evidence through a local API and Model
Context Protocol (MCP) server. This self-contained prototype combines a
commit-pinned collector, SQLite storage, an ingestion queue, and local
persona-based access checks.

Use it to supply source-cited retrieval tools to an approved assistant client
while keeping deterministic source extraction separate from model reasoning.

## What it does

- Queues local ingestion jobs and persists the resulting index in SQLite.
- Provides a loopback-only HTTP API and MCP tools for cited search, repository
  profiles, fact comparisons, and application resolution.
- Applies local persona and access-group checks before returning results.
- Preserves exact commit and source citations, and reports partial coverage and
  unknowns explicitly.

## Run locally

Requirements: Node.js 24+ and Git. No package installation is needed.

```powershell
Push-Location .\core
node --test .\test\index.test.mjs
Pop-Location

Push-Location .\design-2
npm test
Pop-Location
```

See `design-2\README.txt` for configuration, approval, API, and MCP setup. Do
not configure a real source checkout until its owner has approved the exact
commit, path allowlist, and audience.

## Scope and status

This is a local development prototype, not a deployed enterprise or Foundry
service. Bring your own approved source checkouts, exact commit SHAs, path
allowlists, access groups, and human-reviewed application mappings. No
organization-specific source, source-derived index, inventory, credentials,
production identity integration, Azure AI Search, Foundry endpoint, or cloud
resources are bundled.

Search is lexical, not semantic. Missing evidence remains unknown. Unit tests
use generated fixtures, not evidence about any organization's repositories.

Copilot can serve as the model client over MCP when separately configured. The
service itself does not call Foundry and its local persona checks are not a
replacement for GitHub or Microsoft Entra production authorization.

## Companion architecture

The [GitHub-Native Engineering Knowledge Hub](https://github.com/johnsont1693/engineering-knowledge-hub)
provides a CLI and GitHub/Copilot templates over the same collector. Each
repository includes its own copy of the collector and contract, so neither
requires the other to run. Shared changes must be kept in sync.
