import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compareFact, ingestRepositories, repositorySummary, searchIndex, validateIndex } from '../index.mjs';

const coreDirectory = resolve(fileURLToPath(new URL('..', import.meta.url)));
const scratchRoot = join(coreDirectory, '.test-workspaces');

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    input: options.input,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024
  }).trim();
}

function createRepo() {
  mkdirSync(scratchRoot, { recursive: true });
  const checkout = mkdtempSync(join(scratchRoot, 'repo-'));
  run('git', ['init', '-q', checkout]);
  run('git', ['config', 'user.email', 'core-tests@example.invalid'], { cwd: checkout });
  run('git', ['config', 'user.name', 'Core Tests'], { cwd: checkout });
  return checkout;
}

function writeRepoFile(checkout, path, content) {
  const target = join(checkout, ...path.split('/'));
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

function commitAll(checkout, message = 'test commit') {
  run('git', ['add', '-A'], { cwd: checkout });
  run('git', ['commit', '-q', '-m', message], { cwd: checkout });
  return run('git', ['rev-parse', 'HEAD'], { cwd: checkout });
}

function ingest(checkout, id = 'test-repo', options = {}) {
  const effectiveOptions = { ...options };
  const includePaths = effectiveOptions.includePaths ?? ['**'];
  delete effectiveOptions.includePaths;
  return ingestRepositories([{ id, checkout, accessGroup: 'test-access', includePaths }], effectiveOptions);
}

test.after(() => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

test('reads only immutable Git blobs at the requested commit, not dirty working-tree edits', () => {
  const checkout = createRepo();
  writeRepoFile(checkout, 'src/service.js', 'export const pinnedValue = "pinned needle";\n');
  const commit = commitAll(checkout);
  writeRepoFile(checkout, 'src/service.js', 'export const replacedValue = "replacement object";\n');
  const replacementCommit = commitAll(checkout, 'replacement object commit');
  run('git', ['replace', commit, replacementCommit], { cwd: checkout });
  writeRepoFile(checkout, 'src/service.js', 'export const dirtyValue = "working tree";\n');

  const index = ingestRepositories([{ id: 'pinned', checkout, commit, accessGroup: 'private-test' }], { includePaths: ['src/*.js'] });
  assert.equal(index.repositories[0].commit, commit);
  assert.equal(index.repositories[0].accessGroup, 'private-test');
  assert.equal(run('git', ['rev-parse', 'HEAD'], { cwd: checkout }), replacementCommit);
  assert.equal(searchIndex(index, { query: 'pinned needle' }).results.length, 1);
  assert.equal(searchIndex(index, { query: 'dirtyValue' }).results.length, 0);
  assert.equal(searchIndex(index, { query: 'replacement object' }).results.length, 0);
});

test('rejects revision expressions and non-commit object IDs', () => {
  const checkout = createRepo();
  writeRepoFile(checkout, 'README.md', '# Repo\n');
  const commit = commitAll(checkout);
  assert.throws(() => ingestRepositories([{ id: 'rev', checkout, commit: 'HEAD', accessGroup: 'x', includePaths: ['**'] }]), /full 40-character/);
  const blob = run('git', ['rev-parse', `${commit}:README.md`], { cwd: checkout });
  assert.throws(() => ingestRepositories([{ id: 'blob', checkout, commit: blob, accessGroup: 'x', includePaths: ['**'] }]), /not a commit/);
});

test('excludes traversal-like names, environment files, symlinks, datasets, and unsafe filenames', () => {
  const checkout = createRepo();
  writeRepoFile(checkout, 'src/kept.py', 'def safe():\n    return 1\n');
  writeRepoFile(checkout, '.env.production', 'NOT_A_REAL_SECRET=example-value\n');
  writeRepoFile(checkout, 'data/synthetic.csv', 'synthetic,data\nx,y\n');
  writeRepoFile(checkout, 'records.tsv', 'synthetic\tdata\n');
  const targetOid = run('git', ['hash-object', '-w', '--stdin'], { cwd: checkout, input: 'kept.py' });
  run('git', ['update-index', '--add', '--cacheinfo', `120000,${targetOid},src/link.py`], { cwd: checkout });
  commitAll(checkout);

  const index = ingest(checkout);
  assert.equal(index.chunks.some((chunk) => chunk.path.toLowerCase().includes('.env')), false);
  assert.equal(index.chunks.some((chunk) => /(?:^|\/)data\//u.test(chunk.path)), false);
  assert.equal(index.chunks.some((chunk) => chunk.path.endsWith('.tsv')), false);
  assert.equal(index.chunks.some((chunk) => chunk.path.includes('\\')), false);
  assert.equal(index.chunks.some((chunk) => chunk.path.endsWith('link.py')), false);
  assert.ok(index.warnings.some((warning) => warning.includes('environment/secret path')));
  assert.ok(index.warnings.some((warning) => warning.includes('restricted directory')));
});

test('fails closed when no path allowlist is supplied', () => {
  const checkout = createRepo();
  writeRepoFile(checkout, 'README.md', '# Requires an explicit allowlist\n');
  commitAll(checkout);
  assert.throws(
    () => ingestRepositories([{ id: 'no-allowlist', checkout, accessGroup: 'test-access' }]),
    /requires an options or spec includePaths\/allowedPaths\/allowPaths allowlist/
  );
});

test('applies fail-closed normalized include globs before reading blobs', () => {
  const checkout = createRepo();
  writeRepoFile(checkout, 'README.md', '# Authorized root README\n');
  writeRepoFile(checkout, 'analysis/allowed.py', 'def allowed():\n    return True\n');
  writeRepoFile(checkout, 'analysis/nested/not-allowed.py', 'def not_allowed():\n    return False\n');
  writeRepoFile(checkout, 'requirements/spec.md', '# Requirement\n');
  writeRepoFile(checkout, 'checks/expected.txt', 'Expected check description.\n');
  writeRepoFile(checkout, 'scripts/outside.js', 'export const outsideScope = "must not be read";\n');
  writeRepoFile(checkout, 'tests/outside_test.py', 'def outside_test():\n    return "must not be read"\n');
  writeRepoFile(checkout, '.github/workflows/outside.yml', 'name: Outside\non: push\n');
  writeRepoFile(checkout, 'data/restricted.csv', 'restricted,synthetic\n');
  writeRepoFile(checkout, 'workshop/instructions.md', '# Must not be read\n');
  const commit = commitAll(checkout);
  const deniedPaths = [
    'scripts/outside.js',
    'tests/outside_test.py',
    '.github/workflows/outside.yml',
    'data/restricted.csv',
    'workshop/instructions.md'
  ];
  const deniedOids = deniedPaths.map((path) => run('git', ['rev-parse', `${commit}:${path}`], { cwd: checkout }));
  const tracePath = join(checkout, 'include-trace.txt');
  const previous = process.env.GIT_TRACE;
  process.env.GIT_TRACE = tracePath;
  let index;
  try {
    index = ingestRepositories([{
      id: 'scoped', checkout, accessGroup: 'scoped-access',
      includePaths: ['README.md', 'analysis/*.py', 'requirements/**', 'checks/**']
    }]);
  } finally {
    if (previous === undefined) delete process.env.GIT_TRACE;
    else process.env.GIT_TRACE = previous;
  }
  const trace = readFileSync(tracePath, 'utf8');
  assert.ok(deniedOids.every((oid) => !trace.includes(oid)));
  assert.match(trace, /cat-file blob/u);
  assert.deepEqual(index.chunks.map((chunk) => chunk.path), [
    'README.md', 'analysis/allowed.py', 'checks/expected.txt', 'requirements/spec.md'
  ]);
  assert.equal(index.repositories[0].accessGroup, 'scoped-access');
  assert.equal(index.repositories[0].status, 'partial');
  assert.ok(index.warnings.some((warning) => warning.includes('outside includePaths')));
  assert.ok(index.warnings.some((warning) => warning.includes('restricted directory')));
  const narrower = ingestRepositories([{
    id: 'narrower', checkout, accessGroup: 'scoped-access',
    includePaths: ['README.md', 'analysis/*.py', 'requirements/**', 'checks/**']
  }], { includePaths: ['analysis/**'] });
  assert.deepEqual(narrower.chunks.map((chunk) => chunk.path), ['analysis/allowed.py']);
  const optionsOnly = ingestRepositories([{
    id: 'options-only', checkout, accessGroup: 'scoped-access'
  }], { includePaths: ['README.md'] });
  assert.deepEqual(optionsOnly.chunks.map((chunk) => chunk.path), ['README.md']);
  const configuredAlias = ingestRepositories([{
    id: 'configured-alias', checkout, accessGroup: 'scoped-access'
  }], { allowPaths: ['README.md'] });
  assert.deepEqual(configuredAlias.chunks.map((chunk) => chunk.path), ['README.md']);
  for (const unsafeGlob of ['../**', 'C:\\**', '/absolute/**', './README.md', 'analysis/[ab].py']) {
    assert.throws(() => ingestRepositories([{
      id: 'unsafe-glob', checkout, accessGroup: 'x', includePaths: [unsafeGlob]
    }]), /invalid or unsupported/);
  }
});

test('skips an entire secret-bearing source file and preserves a warning', () => {
  const checkout = createRepo();
  writeRepoFile(checkout, 'src/config.js', 'export const ordinary = true;\nconst API_KEY = "synthetic-secret-value-123";\n');
  writeRepoFile(checkout, 'src/other.js', 'export const ordinaryElsewhere = true;\n');
  writeRepoFile(checkout, 'package.json', '{\n  "api_key": "synthetic-secret-value-123"\n}\n');
  const privateKeyMarker = `-----BEGIN ${"PRIVATE KEY"}-----`;
  writeRepoFile(checkout, 'src/key.js', `${privateKeyMarker}\nnot-a-real-key\n-----END PRIVATE KEY-----\n`);
  commitAll(checkout);
  const index = ingest(checkout);
  assert.equal(index.chunks.some((chunk) => chunk.path === 'src/config.js'), false);
  assert.equal(index.chunks.some((chunk) => chunk.path === 'package.json'), false);
  assert.equal(index.chunks.some((chunk) => chunk.path === 'src/key.js'), false);
  assert.ok(index.chunks.some((chunk) => chunk.path === 'src/other.js'));
  assert.ok(index.warnings.some((warning) => warning.includes('secret-like content')));
});

test('rejects opaque invalid UTF-8 source instead of indexing replacement characters', () => {
  const checkout = createRepo();
  const invalidFile = join(checkout, 'opaque.py');
  writeFileSync(invalidFile, Buffer.from([0x64, 0x65, 0x66, 0x20, 0xff, 0x00]));
  commitAll(checkout);
  const index = ingest(checkout);
  assert.equal(index.chunks.some((chunk) => chunk.path === 'opaque.py'), false);
  assert.ok(index.warnings.some((warning) => warning.includes('invalid UTF-8 source')));
  assert.equal(index.repositories[0].status, 'partial');
});

test('extracts manifest versions, workflow literals, exact citations, and commit-pinned facts', () => {
  const checkout = createRepo();
  writeRepoFile(checkout, 'package.json', '{\n  "dependencies": {\n    "actual-package": "^2.4.1"\n  }\n}\n');
  writeRepoFile(checkout, '.github/workflows/verify.yml', 'name: Verify\non:\n  push:\n  pull_request:\njobs:\n  test:\n    steps:\n      - uses: actions/checkout@v4\n');
  writeRepoFile(checkout, 'requirements/AE-3.md', 'AE-3: Include severe events\n');
  writeRepoFile(checkout, 'src/routes.js', 'export function register() {}\nexport { register as setup }\nrouter.get("/health", handler);\n');
  const commit = commitAll(checkout);
  const index = ingest(checkout);

  const dependency = index.facts.find((fact) => fact.kind === 'package.dependency');
  assert.deepEqual([dependency.name, dependency.value], ['dependencies.actual-package', '^2.4.1']);
  assert.deepEqual([dependency.evidence[0].startLine, dependency.evidence[0].endLine], [3, 3]);
  assert.equal(dependency.commit, commit);
  assert.match(dependency.evidence[0].blobSha, /^[a-f0-9]{40}$/u);
  assert.ok(index.facts.some((fact) => fact.kind === 'workflow.trigger' && fact.name === 'pull_request'));
  assert.ok(index.facts.some((fact) => fact.kind === 'workflow.action' && fact.name === 'actions/checkout@v4'));
  assert.ok(index.facts.some((fact) => fact.kind === 'requirement.identifier' && fact.name === 'AE-3'));
  assert.ok(index.facts.some((fact) => fact.kind === 'javascript.export' && fact.name === 'register'));
  assert.ok(index.facts.some((fact) => fact.kind === 'javascript.export' && fact.name === 'setup'));
  const route = index.facts.find((fact) => fact.kind === 'javascript.route');
  assert.deepEqual(route.value, { method: 'get', path: '/health' });
  assert.deepEqual([route.evidence[0].startLine, route.evidence[0].endLine], [3, 3]);
  assert.equal(validateIndex(index), index);
});

test('uses Python AST parsing without executing source', () => {
  const checkout = createRepo();
  writeRepoFile(checkout, 'analysis/module.py',
    'from pathlib import Path\nPath("marker.txt").write_text("must not run")\nclass Processor:\n    def transform(self):\n        return 1\n');
  commitAll(checkout);
  const index = ingest(checkout);
  assert.ok(index.facts.some((fact) => fact.kind === 'python.class' && fact.name === 'Processor'));
  assert.ok(index.facts.some((fact) => fact.kind === 'python.function' && fact.name === 'Processor.transform'));
  assert.ok(index.facts.some((fact) => fact.kind === 'python.module' && fact.name === 'analysis/module'));
  assert.ok(index.facts.some((fact) => fact.kind === 'python.from-import' && fact.name === 'pathlib'));
  assert.equal(index.chunks.some((chunk) => chunk.path === 'marker.txt'), false);
  assert.equal(searchIndex(index, { query: 'must not run' }).results.length, 1);
});

test('reports bounded ingestion and search as partial rather than complete', () => {
  const checkout = createRepo();
  writeRepoFile(checkout, 'a.js', 'export const alpha = "needle";\n');
  writeRepoFile(checkout, 'b.js', 'export const beta = "needle";\n');
  commitAll(checkout);

  const limited = ingest(checkout, 'limited', { maxFiles: 1 });
  assert.equal(limited.repositories[0].status, 'partial');
  assert.ok(limited.warnings.some((warning) => warning.includes('limits prevented')));
  const search = searchIndex(limited, { query: 'needle', maxResults: 1 });
  assert.equal(search.status, 'partial');
  assert.equal(search.coverage.truncated, false);
  const byteLimited = ingest(checkout, 'byte-limited', { maxTotalBytes: 2 });
  assert.equal(byteLimited.repositories[0].status, 'partial');
  assert.equal(byteLimited.repositories[0].fileCount, 0);
  const longLineRepo = createRepo();
  writeRepoFile(longLineRepo, 'README.md', `${'x'.repeat(50)}\n`);
  commitAll(longLineRepo);
  const lineLimited = ingest(longLineRepo, 'line-limited', { maxChunkChars: 10 });
  assert.equal(lineLimited.repositories[0].status, 'partial');
  assert.equal(lineLimited.repositories[0].fileCount, 0);
  assert.equal(lineLimited.chunks.length, 0);
});

test('cross-repository search returns all AND/phrase matches with citations and explicit unknowns', () => {
  const first = createRepo();
  const second = createRepo();
  writeRepoFile(first, 'README.md', '# alpha needle\nA unique phrase is here.\n');
  writeRepoFile(second, 'README.md', '# alpha needle\nA unique phrase is here.\n');
  commitAll(first);
  commitAll(second);
  const index = ingestRepositories([
    { id: 'one', checkout: first, accessGroup: 'group-one', includePaths: ['README.md'] },
    { id: 'two', checkout: second, accessGroup: 'group-two', includePaths: ['README.md'] }
  ]);

  const complete = searchIndex(index, { query: 'alpha needle "unique phrase"' });
  assert.equal(complete.status, 'complete');
  assert.equal(complete.results.length, 2);
  assert.equal(searchIndex(index, { query: 'alpha needle' }).results.length, 2);
  const cliBound = searchIndex(index, { query: 'alpha needle', maxResults: Number.MAX_SAFE_INTEGER });
  assert.equal(cliBound.results.length, 2);
  assert.equal(cliBound.coverage.truncated, false);
  assert.ok(complete.results.every((result) => /^[a-f0-9]{40}$/u.test(result.blobSha) && result.startLine >= 1));
  const bounded = searchIndex(index, { query: 'alpha needle', maxResults: 1 });
  assert.equal(bounded.status, 'partial');
  assert.equal(bounded.coverage.matchedChunks, 2);
  const missing = compareFact(index, { kind: 'python.class', name: 'NotPresent' });
  assert.equal(missing.length, 2);
  assert.ok(missing.every((item) => item.known === false && item.missingMeans === 'unknown'));
  assert.equal(repositorySummary(index, 'one').facts.length > 0, true);
});

test('refuses stale citations and duplicate semantic facts', () => {
  const checkout = createRepo();
  writeRepoFile(checkout, 'source.js', 'export const item = 1;\n');
  commitAll(checkout);
  const index = ingest(checkout);
  const stale = structuredClone(index);
  stale.facts[0].commit = 'a'.repeat(40);
  assert.throws(() => validateIndex(stale), /commit does not match/);
  const duplicate = structuredClone(index);
  duplicate.facts.push(structuredClone(duplicate.facts[0]));
  assert.throws(() => validateIndex(duplicate), /duplicates an existing fact/);
  const traversal = structuredClone(index);
  traversal.chunks[0].path = '../escape.js';
  assert.throws(() => validateIndex(traversal), /unsafe/);
  const controlCharacter = structuredClone(index);
  controlCharacter.chunks[0].path = 'unsafe\nname.js';
  assert.throws(() => validateIndex(controlCharacter), /unsafe/);
});

test('does not invoke git log while enumerating commit objects', () => {
  const checkout = createRepo();
  writeRepoFile(checkout, 'README.md', '# Logged only by test tracer\n');
  commitAll(checkout);
  const tracePath = join(checkout, 'git-trace.txt');
  const previous = process.env.GIT_TRACE;
  process.env.GIT_TRACE = tracePath;
  try {
    ingest(checkout);
  } finally {
    if (previous === undefined) delete process.env.GIT_TRACE;
    else process.env.GIT_TRACE = previous;
  }
  const trace = readFileSync(tracePath, 'utf8');
  assert.equal(/\bgit log\b/u.test(trace), false);
  assert.equal(/\bgit fetch\b/u.test(trace), false);
  assert.match(trace, /ls-tree/u);
  assert.match(trace, /cat-file/u);
});
