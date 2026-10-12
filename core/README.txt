Shared commit-pinned Git source core
====================================

This folder is the shared, dependency-free Node 24 ESM implementation of the
contract in ../contract.json. It reads Git tree/blob objects at one immutable
commit. It does not fetch, check out, inspect working-tree source, execute
repository code, or install dependencies. Source text is untrusted data.

API
---

Import from ./index.mjs:

  ingestRepositories(specs, options)
  validateIndex(index)
  searchIndex(index, { query, repositoryIds?, maxResults? })
  repositorySummary(index, repositoryId)
  compareFact(index, { kind, name? })

Each repository spec requires { id, checkout, accessGroup }; displayName and
commit are optional. An omitted commit resolves only the checkout's local
HEAD. Supplied commits must be full lowercase 40-character object IDs for
commit objects. The returned index preserves accessGroup and records full
commit and blob IDs with line citations.

An authorized path allowlist is required for every repository; without one,
ingestion fails before Git object reads. Pass a non-empty includePaths string
array on the repository spec or in the second options argument. The canonical
shared option is options.includePaths; options.allowedPaths and options.allowPaths
are accepted aliases. When spec and option filters are both supplied, a path
must match at least one pattern in each filter. Patterns are case-sensitive,
root-anchored repo-relative paths using `/`: `*` matches zero or more characters
within one path component, `?` matches exactly one non-slash character, `**`
matches zero or more characters including `/`, and `**/` matches zero or more
complete directory components. For example, `analysis/*.py` matches direct
children only; `analysis/**/*.py` also matches nested children. Lists are
limited to 100 patterns of at most 512 characters each. Absolute/drive paths,
colons, backslashes, empty/`.`/`..` components, controls, whitespace padding,
and bracket/brace expressions are rejected. Glob escaping, expansion, and
character classes are unsupported. The core enumerates Git tree metadata, then
filters before `cat-file` size/blob reads; sensitive-path exclusions still
apply. Omitted paths are counted in warnings and coverage is marked partial.

Search evaluates every eligible chunk in the selected repositories. Terms are
ANDed; double-quoted phrases are substring matched. By default maxResults is
the index's full chunk count, so all matches are returned. Callers may supply
an explicit positive safe-integer maxResults bound; Number.MAX_SAFE_INTEGER is
accepted. Any truncation or partial source makes status partial. Missing facts
are reported as unknown, never as evidence of absence. Callers must apply
repository authorization before querying; pass an index containing only
repositories the caller may access to compareFact.

Source-format eligibility is not a path authorization: every blob must also
match the required allowlist. Eligible text formats include source code,
README, requirements/checks, package.json, and GitHub workflows. The core skips data/workshop paths,
customer/private/transcript paths, environment files, binaries, datasets,
vendor/generated files, symlinks, lockfiles, invalid UTF-8, and any whole file
containing secret-like lines or private-key markers. Exclusions and ingestion
limits are reported, and the repository status is partial when coverage is
incomplete. File, byte, chunk-line, chunk-token, and chunk-character limits
are configurable through ingestRepositories options, including the repository
chunk ceiling. The token bound is a deterministic whitespace-token count,
not a model-specific tokenizer.

Python definitions/imports are parsed by Python's isolated standard-library
AST parser (`python -I -S -c`); repository text is passed only as parser input,
never evaluated. If Python is unavailable, ingestion explicitly marks the
omitted AST extraction as partial.

Validation
----------

From this folder, run:

  node --test test/index.test.mjs

The tests create short-lived local Git repositories from generated test
strings, remove them after the run, and do not include fixture/demo data in the
deliverable.

No source repository or source-derived index is bundled. Unit tests create
temporary Git repositories from generated fixture content. Any separate
integration run must use a source checkout, exact commit, audience, and path
allowlist approved by that source's owner. Do not commit generated indexes or
describe synthetic fixtures as customer evidence.
