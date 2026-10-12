import { execFileSync, spawnSync } from 'node:child_process';
import { basename, extname, resolve } from 'node:path';
import { statSync } from 'node:fs';
import { TextDecoder } from 'node:util';

const SCHEMA_VERSION = '1.0';
const SHA_RE = /^[a-f0-9]{40}$/;
const factIdentities = new WeakMap();
const PYTHON_AST_SCRIPT = [
  'import ast, json, sys',
  'source = sys.stdin.read()',
  'try:',
  '    tree = ast.parse(source)',
  'except SyntaxError as exc:',
  '    print(json.dumps({"syntaxError": exc.lineno or 1}))',
  '    raise SystemExit(0)',
  'items = []',
  'def walk(node, scope):',
  '    for child in ast.iter_child_nodes(node):',
  '        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):',
  '            kind = "class" if isinstance(child, ast.ClassDef) else ("async function" if isinstance(child, ast.AsyncFunctionDef) else "function")',
  '            name = ".".join(scope + [child.name])',
  '            items.append({"kind": kind, "name": name, "startLine": child.lineno, "endLine": child.end_lineno or child.lineno})',
  '            walk(child, scope + [child.name])',
  '        elif isinstance(child, ast.Import):',
  '            names = [{"name": a.name, "alias": a.asname} for a in child.names]',
  '            items.append({"kind": "import", "name": ",".join(a["name"] for a in names), "value": names, "startLine": child.lineno, "endLine": child.end_lineno or child.lineno})',
  '        elif isinstance(child, ast.ImportFrom):',
  '            names = [{"name": a.name, "alias": a.asname} for a in child.names]',
  '            items.append({"kind": "from-import", "name": child.module or ".", "value": {"level": child.level, "module": child.module, "names": names}, "startLine": child.lineno, "endLine": child.end_lineno or child.lineno})',
  '            walk(child, scope)',
  '        else:',
  '            walk(child, scope)',
  'walk(tree, [])',
  'print(json.dumps({"items": items}, ensure_ascii=True))'
].join('\n');

const SOURCE_EXTENSIONS = new Set([
  '.py', '.pyi', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx',
  '.java', '.go', '.rs', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs',
  '.rb', '.php', '.swift', '.scala', '.kt', '.kts', '.sh', '.bash',
  '.r', '.sas', '.sql', '.pl', '.ps1'
]);
const LANGUAGE_BY_EXTENSION = new Map([
  ['.py', 'Python'], ['.pyi', 'Python'], ['.js', 'JavaScript'], ['.jsx', 'JavaScript'],
  ['.mjs', 'JavaScript'], ['.cjs', 'JavaScript'], ['.ts', 'TypeScript'], ['.tsx', 'TypeScript'],
  ['.java', 'Java'], ['.go', 'Go'], ['.rs', 'Rust'], ['.c', 'C'], ['.h', 'C/C++'],
  ['.cc', 'C++'], ['.cpp', 'C++'], ['.hpp', 'C++'], ['.cs', 'C#'], ['.rb', 'Ruby'],
  ['.php', 'PHP'], ['.swift', 'Swift'], ['.scala', 'Scala'], ['.kt', 'Kotlin'],
  ['.kts', 'Kotlin'], ['.sh', 'Shell'], ['.bash', 'Shell'], ['.r', 'R'],
  ['.sas', 'SAS'], ['.sql', 'SQL'], ['.pl', 'Perl'], ['.ps1', 'PowerShell']
]);

function git(checkout, args, options = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|CONFIG|CONFIG_GLOBAL|CONFIG_SYSTEM|CONFIG_NOSYSTEM|CONFIG_COUNT|CONFIG_PARAMETERS)(?:_|$)/u.test(key)) {
      delete env[key];
    }
  }
  env.GIT_NO_LAZY_FETCH = '1';
  env.GIT_OPTIONAL_LOCKS = '0';
  return execFileSync('git', ['--no-replace-objects', '-C', checkout, ...args], {
    encoding: options.encoding,
    input: options.input,
    env,
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    timeout: options.timeout ?? 30_000,
    windowsHide: true,
    ...(options.encoding ? {} : { encoding: 'buffer' })
  });
}

function checkedCheckout(checkout) {
  if (typeof checkout !== 'string' || checkout.length === 0) {
    throw new TypeError('Repository checkout must be a non-empty local path.');
  }
  const absolute = resolve(checkout);
  const info = statSync(absolute);
  if (!info.isDirectory()) throw new Error(`Repository checkout is not a directory: ${absolute}`);
  return absolute;
}

function resolveCommit(checkout, requestedCommit) {
  let commit = requestedCommit;
  if (commit !== undefined) {
    if (typeof commit !== 'string' || !SHA_RE.test(commit)) {
      throw new Error('commit must be a full 40-character lowercase hexadecimal object ID.');
    }
    const type = String(git(checkout, ['cat-file', '-t', commit], { encoding: 'utf8' })).trim();
    if (type !== 'commit') throw new Error(`Supplied object ${commit} is not a commit.`);
  } else {
    commit = String(git(checkout, ['rev-parse', '--verify', 'HEAD^{commit}'], { encoding: 'utf8' })).trim();
    if (!SHA_RE.test(commit)) throw new Error('Local HEAD did not resolve to a full commit object ID.');
    const type = String(git(checkout, ['cat-file', '-t', commit], { encoding: 'utf8' })).trim();
    if (type !== 'commit') throw new Error('Local HEAD does not identify a commit object.');
  }
  return commit;
}

function parseTree(checkout, commit, warnings) {
  const raw = git(checkout, ['ls-tree', '-r', '-z', '--full-tree', commit]);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const entries = [];
  let invalidPathCount = 0;
  for (const record of raw.toString('binary').split('\0')) {
    if (record.length === 0) continue;
    const tabAt = record.indexOf('\t');
    if (tabAt < 0) throw new Error('Git returned a malformed ls-tree record.');
    const metadata = record.slice(0, tabAt).split(' ');
    if (metadata.length !== 3 || !SHA_RE.test(metadata[2])) {
      throw new Error('Git returned malformed tree metadata.');
    }
    let path;
    try {
      path = decoder.decode(Buffer.from(record.slice(tabAt + 1), 'binary'));
    } catch {
      invalidPathCount++;
      continue;
    }
    entries.push({ mode: metadata[0], type: metadata[1], oid: metadata[2], path });
  }
  if (invalidPathCount) warnings.push(`Excluded ${invalidPathCount} path(s) with invalid UTF-8.`);
  return entries;
}

function safeRepoPath(path) {
  if (path.length === 0 || path.startsWith('/') || path.includes('\\') || path.includes(':') ||
      /^[A-Za-z]:/u.test(path) || /[\u0000-\u001f\u007f]/u.test(path)) return false;
  const parts = path.split('/');
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function compileIncludePaths(patterns, label) {
  if (patterns === undefined) return undefined;
  if (!Array.isArray(patterns) || patterns.length === 0 || patterns.length > 100) {
    throw new TypeError(`${label} must be a non-empty array of at most 100 repo-relative globs.`);
  }
  return patterns.map((pattern) => {
    if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > 512 ||
        pattern.trim() !== pattern || !safeRepoPath(pattern) || /[\[\]{}]/u.test(pattern)) {
      throw new Error(`${label} contains an invalid or unsupported repo-relative glob.`);
    }
    let source = '^';
    for (let index = 0; index < pattern.length; index++) {
      const char = pattern[index];
      if (char === '*' && pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          source += '(?:.*/)?';
          index += 2;
        } else {
          source += '.*';
          index++;
        }
      } else if (char === '*') {
        source += '[^/]*';
      } else if (char === '?') {
        source += '[^/]';
      } else {
        source += char.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&');
      }
    }
    return new RegExp(`${source}$`, 'u');
  });
}

function compilePathFilters(owner, label) {
  const filters = [];
  for (const key of ['includePaths', 'allowedPaths', 'allowPaths']) {
    if (owner[key] !== undefined) filters.push(compileIncludePaths(owner[key], `${label}.${key}`));
  }
  return filters;
}

function pathCategory(path, mode, type) {
  if (!safeRepoPath(path)) return 'unsafe path';
  const lower = path.toLowerCase();
  const parts = lower.split('/');
  const leaf = parts.at(-1);
  if (parts.includes('.git')) return 'Git metadata';
  if (parts.some((part) => part === 'data' || part === 'workshop')) return 'restricted directory';
  if (parts.some((part) => /(?:^|[-_.])(?:customers?|private|confidential|proprietary|transcripts?|recordings?|screenshots?)(?:$|[-_.])/i.test(part))) return 'customer, private, transcript, or screenshot path';
  if (parts.some((part) => /^\.env/i.test(part))) return 'environment/secret path';
  if (parts.some((part) => /(?:^|[-_.])(?:secrets?|credentials?)(?:$|[-_.])/i.test(part))) return 'secret path';
  if (mode === '120000' || type !== 'blob') return 'symlink or non-blob';
  if (/(?:^|\/)(?:node_modules|vendor|third_party|dist|build|coverage|target|__pycache__|generated|gen)(?:\/|$)/i.test(path)) {
    return 'vendor or generated path';
  }
  if (/\.(?:map|lock)$/i.test(leaf) || /^(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|pipfile\.lock|cargo\.lock|gemfile\.lock|composer\.lock)$/i.test(leaf)) {
    return 'lockfile or source map';
  }
  if (/\.(?:csv|tsv|parquet|jsonl|ndjson|avro|feather|arrow|sqlite|db|log|png|jpe?g|gif|bmp|tiff?|webp|pdf|zip|gz|tar|wasm|exe|dll|so|dylib|class|pyc)$/i.test(leaf)) {
    return 'dataset, binary, or generated artifact';
  }
  if (/\.min\.(?:js|css)$/i.test(leaf) || /\.(?:bundle|generated)\.(?:js|ts|css)$/i.test(leaf)) return 'generated artifact';
  if (leaf === 'package.json') return null;
  if (SOURCE_EXTENSIONS.has(extname(leaf).toLowerCase())) return null;
  if (/^readme(?:\.(?:md|markdown|rst|txt))?$/i.test(leaf)) return null;
  if (parts.includes('requirements') || parts.includes('checks')) {
    if (/\.(?:md|markdown|rst|txt)$/i.test(leaf)) return null;
  }
  if (parts.length === 3 && parts[0] === '.github' && parts[1] === 'workflows' && /\.(?:yml|yaml)$/i.test(leaf)) return null;
  if (leaf === 'requirements.txt') return null;
  return 'unsupported path or format';
}

function containsSecret(text) {
  const lines = text.split(/\r?\n/u);
  const privateKey = /-----BEGIN (?:[A-Z0-9 ]* )?PRIVATE KEY-----/u;
  const assignment = /^\s*[\s,{]*(?:(?:export\s+)?(?:const|let|var)\s+)?(?:[A-Z0-9_$.-]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API[_-]?KEY|CLIENT[_-]?SECRET|ACCESS[_-]?KEY|PRIVATE[_-]?KEY)[A-Z0-9_$.-]*|["'][A-Z0-9_$.-]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API[_-]?KEY|CLIENT[_-]?SECRET|ACCESS[_-]?KEY|PRIVATE[_-]?KEY)[A-Z0-9_$.-]*["'])\s*[:=]\s*(['"]?)(?!\$\{|<|REDACTED\b|YOUR_|CHANGE_ME\b|example\b|test\b)([^\s'"#]{8,})/iu;
  const knownCredential = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9_]{30,}\b|\bsk-[A-Za-z0-9]{20,}\b|\bAIza[A-Za-z0-9_-]{30,}\b/u;
  const jwt = /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u;
  return lines.some((line) => privateKey.test(line) || assignment.test(line) || knownCredential.test(line) || jwt.test(line));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function addFact(facts, repositoryId, commit, kind, name, value, evidence, extractor) {
  if (!evidence || evidence.length === 0) return;
  const identity = `${repositoryId}\0${commit}\0${kind}\0${name}\0${stableJson(value)}`;
  let identities = factIdentities.get(facts);
  if (!identities) {
    identities = new Map();
    factIdentities.set(facts, identities);
  }
  const existing = identities.get(identity);
  if (existing) {
    const present = new Set(existing.evidence.map((item) => `${item.path}\0${item.startLine}\0${item.endLine}\0${item.blobSha}`));
    for (const citation of evidence) {
      const key = `${citation.path}\0${citation.startLine}\0${citation.endLine}\0${citation.blobSha}`;
      if (!present.has(key)) existing.evidence.push(citation);
    }
    return;
  }
  const fact = { repositoryId, commit, kind, name, value, evidence, extractor, _identity: identity };
  identities.set(identity, fact);
  facts.push(fact);
}

function lineFor(text, offset) {
  let line = 1;
  for (let index = 0; index < offset; index++) if (text.charCodeAt(index) === 10) line++;
  return line;
}

function chunksFor(repositoryId, commit, path, blobSha, language, text, limits) {
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === '') lines.pop();
  const chunks = [];
  let start = 0;
  while (start < lines.length && chunks.length < limits.maxChunksPerFile) {
    let end = start;
    let chars = 0;
    let tokens = 0;
    while (end < lines.length && end - start < limits.maxChunkLines) {
      const length = lines[end].length + (end === start ? 0 : 1);
      const lineTokens = (lines[end].match(/\S+/gu) ?? []).length;
      if (lines[end].length > limits.maxChunkChars || lineTokens > limits.maxChunkTokens) break;
      if (end > start && (chars + length > limits.maxChunkChars || tokens + lineTokens > limits.maxChunkTokens)) break;
      chars += length;
      tokens += lineTokens;
      end++;
    }
    if (end === start) break;
    let chunkText = lines.slice(start, end).join('\n');
    if (chunkText.length === 0 && text.length > 0) chunkText = '\n';
    if (chunkText.length > 0) {
      chunks.push({
        repositoryId, commit, path, startLine: start + 1, endLine: end,
        blobSha, language, text: chunkText
      });
    }
    start = end;
  }
  return { chunks, coveredLines: start, totalLines: lines.length };
}

function lineEvidence(path, blobSha, startLine, endLine) {
  return [{ path, blobSha, startLine, endLine }];
}

function extractDocumentFacts(facts, repositoryId, commit, file, text, coveredLines) {
  const lines = text.split(/\r?\n/u);
  const requirementPath = /(?:^|\/)(?:requirements|checks)(?:\/|$)/i.test(file.path) || /^requirements\.txt$/i.test(file.path);
  for (let index = 0; index < Math.min(lines.length, coveredLines); index++) {
    const line = lines[index];
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u);
    if (heading && /^readme(?:\.|$)/i.test(file.path.split('/').at(-1)) ||
        (heading && /(?:^|\/)(?:requirements|checks)(?:\/|$)/i.test(file.path))) {
      addFact(facts, repositoryId, commit, 'document.heading', heading[2], heading[2],
        lineEvidence(file.path, file.blobSha, index + 1, index + 1), 'markdown-heading');
    }
    if (requirementPath) {
      const match = line.match(/^\s*(?:Requirement\s+)?([A-Z][A-Z0-9]+-\d+)\s*(?:[:—-]\s*|\s+)(.+?)\s*$/u);
      if (match) {
        addFact(facts, repositoryId, commit, 'requirement.identifier', match[1], match[2],
          lineEvidence(file.path, file.blobSha, index + 1, index + 1), 'requirement-identifier-line');
      }
    }
  }
}

function extractJsFacts(facts, repositoryId, commit, file, text, coveredLines) {
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < Math.min(lines.length, coveredLines); index++) {
    const line = lines[index];
    const exported = line.match(/^\s*export\s+(?:(?:declare|default|async)\s+)*(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/u);
    if (exported) {
      addFact(facts, repositoryId, commit, 'javascript.export', exported[1], exported[1],
        lineEvidence(file.path, file.blobSha, index + 1, index + 1), 'literal-export-pattern');
    }
    const exportList = line.match(/^\s*export\s*\{\s*([^}]+)\s*\}/u);
    if (exportList) {
      for (const entry of exportList[1].split(',')) {
        const aliases = entry.trim().split(/\s+as\s+/u).map((part) => part.trim());
        const exportedName = aliases.at(-1);
        if (/^[A-Za-z_$][\w$]*$/u.test(exportedName)) {
          addFact(facts, repositoryId, commit, 'javascript.export', exportedName, exportedName,
            lineEvidence(file.path, file.blobSha, index + 1, index + 1), 'literal-export-pattern');
        }
      }
    }
    const route = line.match(/^\s*(?:(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*)?(?:app|router)\.(get|post|put|patch|delete|all|use)\s*\(\s*(['"])([^'"\r\n]+)\2(?=\s*,)/u);
    if (route) {
      const value = { method: route[1], path: route[3] };
      addFact(facts, repositoryId, commit, 'javascript.route', `${route[1].toUpperCase()} ${route[3]}`, value,
        lineEvidence(file.path, file.blobSha, index + 1, index + 1), 'literal-route-pattern');
    }
  }
}

function locatePackageVersionLine(text, section, key, version) {
  const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  let depth = 0;
  let open = -1;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      const start = index;
      let escaped = false;
      for (index++; index < text.length; index++) {
        if (escaped) escaped = false;
        else if (text[index] === '\\') escaped = true;
        else if (text[index] === '"') break;
      }
      if (depth === 1 && JSON.parse(text.slice(start, index + 1)) === section) {
        let cursor = index + 1;
        while (/\s/u.test(text[cursor] ?? '')) cursor++;
        if (text[cursor] === ':') {
          cursor++;
          while (/\s/u.test(text[cursor] ?? '')) cursor++;
          if (text[cursor] === '{') {
            open = cursor;
            break;
          }
        }
      }
    } else if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
    }
  }
  if (open < 0) return undefined;
  let sectionDepth = 0;
  let inString = false;
  let escaped = false;
  let close = -1;
  for (let index = open; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') sectionDepth++;
    else if (char === '}' && --sectionDepth === 0) {
      close = index;
      break;
    }
  }
  if (close < 0) return undefined;
  const keyLiteral = JSON.stringify(key);
  const versionLiteral = JSON.stringify(version);
  const sectionText = text.slice(open + 1, close);
  const entry = new RegExp(`${escapeRegExp(keyLiteral)}\\s*:\\s*${escapeRegExp(versionLiteral)}`, 'u').exec(sectionText);
  return entry ? lineFor(text, open + 1 + entry.index) : undefined;
}

function extractPackageFacts(facts, repositoryId, commit, file, text, coveredLines, warnings) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    warnings.push(`Skipped malformed package manifest at ${file.path}.`);
    return;
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    warnings.push(`Skipped package manifest with an invalid root at ${file.path}.`);
    return;
  }
  const sections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
  for (const section of sections) {
    const deps = manifest[section];
    if (!deps || typeof deps !== 'object' || Array.isArray(deps)) continue;
    for (const [name, version] of Object.entries(deps)) {
      if (typeof version !== 'string') continue;
      const line = locatePackageVersionLine(text, section, name, version);
      if (line && line <= coveredLines) {
        addFact(facts, repositoryId, commit, 'package.dependency', `${section}.${name}`, version,
          lineEvidence(file.path, file.blobSha, line, line), 'package-json-dependency');
      }
    }
  }
}

function extractWorkflowFacts(facts, repositoryId, commit, file, text, coveredLines) {
  const lines = text.split(/\r?\n/u);
  let inOn = false;
  let rootTrigger = '';
  let triggerStart = 0;
  for (let index = 0; index < Math.min(lines.length, coveredLines); index++) {
    const line = lines[index];
    const root = line.match(/^([A-Za-z][\w-]*):\s*(.*?)\s*$/u);
    if (root) {
      if (inOn && root[1] !== 'on') {
        addWorkflowTrigger(rootTrigger, triggerStart, index, file, facts, repositoryId, commit);
        inOn = false;
      }
      if (root[1] === 'on') {
        inOn = true;
        rootTrigger = root[2];
        triggerStart = index;
      }
    } else if (inOn && /^\s+[\w*-]+(?::|\s*$)/u.test(line)) {
      const trigger = line.trim().replace(/:.*$/u, '');
      rootTrigger += `${rootTrigger ? ', ' : ''}${trigger}`;
    }
    const action = line.match(/^\s*(?:-\s*)?uses:\s*([^\s#]+)\s*$/u);
    if (action) {
      addFact(facts, repositoryId, commit, 'workflow.action', action[1], action[1],
        lineEvidence(file.path, file.blobSha, index + 1, index + 1), 'workflow-uses-literal');
    }
  }
  if (inOn) addWorkflowTrigger(rootTrigger, triggerStart, Math.min(lines.length, coveredLines), file, facts, repositoryId, commit);
}

function addWorkflowTrigger(triggerValue, startIndex, endIndex, file, facts, repositoryId, commit) {
  const normalized = triggerValue.replace(/^\[|\]$/gu, '').trim();
  if (!normalized) return;
  const triggers = normalized.split(/[, ]+/u).map((item) => item.replace(/^['"]|['"]$/gu, '')).filter(Boolean);
  for (const trigger of triggers) {
    addFact(facts, repositoryId, commit, 'workflow.trigger', trigger, trigger,
      lineEvidence(file.path, file.blobSha, startIndex + 1, Math.max(startIndex + 1, endIndex)), 'workflow-on-literal');
  }
}

function extractPythonFacts(facts, repositoryId, commit, file, text, coveredLines, warnings) {
  const result = spawnSync('python', ['-I', '-S', '-c', PYTHON_AST_SCRIPT], {
    input: text,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    timeout: 10_000,
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    warnings.push(`Python AST extraction unavailable for ${file.path}.`);
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    warnings.push(`Python AST extraction returned malformed output for ${file.path}.`);
    return;
  }
  if (parsed.syntaxError) {
    warnings.push(`Python syntax parse failed for ${file.path} at line ${parsed.syntaxError}.`);
    return;
  }
  for (const item of parsed.items) {
    if (item.startLine > coveredLines) continue;
    const endLine = Math.min(item.endLine, coveredLines);
    const kind = item.kind === 'class' || item.kind === 'function' || item.kind === 'async function'
      ? `python.${item.kind.replace(' ', '.')}` : `python.${item.kind}`;
    addFact(facts, repositoryId, commit, kind, item.name, item.value ?? item.kind,
      lineEvidence(file.path, file.blobSha, item.startLine, Math.max(item.startLine, endLine)), 'python-stdlib-ast');
  }
}

function isoNow() {
  return new Date().toISOString();
}

export function ingestRepositories(specs, options = {}) {
  if (!Array.isArray(specs)) throw new TypeError('specs must be an array.');
  const optionPathFilters = compilePathFilters(options, 'options');
  const limits = {
    maxFiles: options.maxFiles ?? 5000,
    maxTotalBytes: options.maxTotalBytes ?? 20 * 1024 * 1024,
    maxFileBytes: options.maxFileBytes ?? 1024 * 1024,
    maxChunksPerFile: options.maxChunksPerFile ?? 200,
    maxChunkLines: options.maxChunkLines ?? 80,
    maxChunkChars: options.maxChunkChars ?? 8000,
    maxChunkTokens: options.maxChunkTokens ?? 500
  };
  const maxChunksPerRepository = options.maxChunksPerRepository ?? 20_000;
  if (!Number.isSafeInteger(maxChunksPerRepository) || maxChunksPerRepository < 1) {
    throw new RangeError('maxChunksPerRepository must be a positive safe integer.');
  }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer.`);
  }
  const index = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: isoNow(),
    repositories: [],
    applications: [],
    facts: [],
    chunks: [],
    warnings: []
  };
  const seenIds = new Set();
  for (const spec of specs) {
    if (!spec || typeof spec !== 'object') throw new TypeError('Each repository spec must be an object.');
    if (typeof spec.id !== 'string' || !/^[A-Za-z0-9._-]+$/u.test(spec.id)) throw new Error('Repository id is invalid.');
    if (seenIds.has(spec.id)) throw new Error(`Duplicate repository id: ${spec.id}`);
    seenIds.add(spec.id);
    if (typeof spec.accessGroup !== 'string' || !spec.accessGroup.trim()) throw new Error(`Repository ${spec.id} requires accessGroup.`);
    const specPathFilters = compilePathFilters(spec, `Repository ${spec.id}`);
    const includeFilters = [...optionPathFilters, ...specPathFilters];
    if (includeFilters.length === 0) {
      throw new Error(`Repository ${spec.id} requires an options or spec includePaths/allowedPaths/allowPaths allowlist.`);
    }
    const checkout = checkedCheckout(spec.checkout);
    const commit = resolveCommit(checkout, spec.commit);
    const localWarnings = [];
    const entries = parseTree(checkout, commit, localWarnings);
    const excluded = new Map();
    const allFacts = [];
    const repoChunks = [];
    let includedFiles = 0;
    let totalBytes = 0n;
    let processedFiles = 0;
    let limitReached = false;
    const languageEvidence = new Map();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    for (const entry of entries) {
      const category = pathCategory(entry.path, entry.mode, entry.type);
      if (category) {
        excluded.set(category, (excluded.get(category) ?? 0) + 1);
        continue;
      }
      if (includeFilters.some((patterns) => !patterns.some((pattern) => pattern.test(entry.path)))) {
        excluded.set('outside includePaths', (excluded.get('outside includePaths') ?? 0) + 1);
        continue;
      }
      if (processedFiles >= limits.maxFiles) {
        limitReached = true;
        continue;
      }
      processedFiles++;
      const sizeText = String(git(checkout, ['cat-file', '-s', entry.oid], { encoding: 'utf8' })).trim();
      if (!/^\d+$/u.test(sizeText)) throw new Error(`Git returned an invalid size for blob ${entry.oid}.`);
      const size = BigInt(sizeText);
      if (size > BigInt(limits.maxFileBytes) || totalBytes + size > BigInt(limits.maxTotalBytes)) {
        limitReached = true;
        continue;
      }
      const blob = git(checkout, ['cat-file', 'blob', entry.oid]);
      if (BigInt(blob.length) !== size) throw new Error(`Git blob size mismatch for ${entry.oid}.`);
      totalBytes += size;
      let text;
      try {
        text = decoder.decode(blob);
      } catch {
        excluded.set('invalid UTF-8 source', (excluded.get('invalid UTF-8 source') ?? 0) + 1);
        continue;
      }
      if (containsSecret(text)) {
        excluded.set('secret-like content', (excluded.get('secret-like content') ?? 0) + 1);
        continue;
      }
      if (text.length === 0) {
        excluded.set('empty source', (excluded.get('empty source') ?? 0) + 1);
        continue;
      }
      const { chunks, coveredLines, totalLines } = chunksFor(
        spec.id, commit, entry.path, entry.oid,
        LANGUAGE_BY_EXTENSION.get(extname(entry.path).toLowerCase()) ?? (entry.path.toLowerCase().endsWith('.json') ? 'JSON' : 'text'),
        text, limits
      );
      if (chunks.length === 0 || coveredLines === 0) {
        limitReached = true;
        continue;
      }
      if (repoChunks.length + chunks.length > maxChunksPerRepository) {
        limitReached = true;
        break;
      }
      if (coveredLines < totalLines) limitReached = true;
      repoChunks.push(...chunks);
      includedFiles++;
      const file = { path: entry.path, blobSha: entry.oid };
      extractDocumentFacts(allFacts, spec.id, commit, file, text, coveredLines);
      if (SOURCE_EXTENSIONS.has(extname(entry.path).toLowerCase())) {
        const language = LANGUAGE_BY_EXTENSION.get(extname(entry.path).toLowerCase()) ?? 'Unknown';
        const evidence = lineEvidence(entry.path, entry.oid, 1, Math.max(1, Math.min(coveredLines, totalLines)))[0];
        const current = languageEvidence.get(language) ?? { fileCount: 0, evidence: [] };
        current.fileCount++;
        current.evidence.push(evidence);
        languageEvidence.set(language, current);
        if (extname(entry.path).toLowerCase() === '.py') {
          const moduleName = entry.path.slice(0, -extname(entry.path).length);
          addFact(allFacts, spec.id, commit, 'python.module', moduleName, moduleName,
            lineEvidence(entry.path, entry.oid, 1, 1), 'python-file-path');
          extractPythonFacts(allFacts, spec.id, commit, file, text, coveredLines, localWarnings);
        } else if (['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'].includes(extname(entry.path).toLowerCase())) {
          extractJsFacts(allFacts, spec.id, commit, file, text, coveredLines);
        }
      }
      if (entry.path.toLowerCase().endsWith('/package.json') || entry.path.toLowerCase() === 'package.json') {
        extractPackageFacts(allFacts, spec.id, commit, file, text, coveredLines, localWarnings);
      }
      if (/^\.github\/workflows\/[^/]+\.(?:yml|yaml)$/i.test(entry.path)) {
        extractWorkflowFacts(allFacts, spec.id, commit, file, text, coveredLines);
      }
    }
    for (const [language, inventory] of languageEvidence) {
      addFact(allFacts, spec.id, commit, 'repository.language', language, { fileCount: inventory.fileCount },
        inventory.evidence, 'source-file-extension');
    }
    for (const [category, count] of excluded) {
      localWarnings.push(`Excluded ${count} tracked path(s): ${category}.`);
    }
    if (limitReached) localWarnings.push('Ingestion limits prevented indexing all eligible files or lines.');
    const status = localWarnings.length > 0 || limitReached ? 'partial' : 'complete';
    index.repositories.push({
      id: spec.id,
      displayName: spec.displayName ?? basename(checkout),
      remoteUrl: null,
      commit,
      collectedAt: isoNow(),
      status,
      accessGroup: spec.accessGroup,
      fileCount: includedFiles
    });
    index.warnings.push(...localWarnings.map((warning) => `${spec.id}: ${warning}`));
    index.chunks.push(...repoChunks);
    for (const { _identity, ...fact } of allFacts) index.facts.push(fact);
  }
  return validateIndex(index);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isJsonValue(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  const nested = new Set(ancestors);
  nested.add(value);
  return (Array.isArray(value) ? value : Object.values(value)).every((item) => isJsonValue(item, nested));
}

function isDateTime(value) {
  return typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    !Number.isNaN(Date.parse(value));
}

function checkExactKeys(value, allowed, required, label, errors) {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object.`);
    return false;
  }
  for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push(`${label} has unsupported property ${key}.`);
  for (const key of required) if (!(key in value)) errors.push(`${label} is missing ${key}.`);
  return true;
}

function validateIndex(index) {
  const errors = [];
  const rootKeys = ['schemaVersion', 'generatedAt', 'repositories', 'applications', 'facts', 'chunks', 'warnings'];
  if (!checkExactKeys(index, rootKeys, rootKeys, 'index', errors)) throw new Error(errors.join('\n'));
  if (index.schemaVersion !== SCHEMA_VERSION) errors.push(`schemaVersion must be ${SCHEMA_VERSION}.`);
  if (!isDateTime(index.generatedAt)) errors.push('generatedAt must be a valid date-time.');
  for (const key of ['repositories', 'applications', 'facts', 'chunks', 'warnings']) {
    if (!Array.isArray(index[key])) errors.push(`${key} must be an array.`);
  }
  if (errors.length) throw new Error(errors.join('\n'));

  const repos = new Map();
  const repoKeys = ['id', 'displayName', 'remoteUrl', 'commit', 'collectedAt', 'status', 'accessGroup', 'fileCount', 'errors'];
  const repoRequired = repoKeys.filter((key) => key !== 'errors');
  for (let i = 0; i < index.repositories.length; i++) {
    const repo = index.repositories[i];
    const label = `repositories[${i}]`;
    if (!checkExactKeys(repo, repoKeys, repoRequired, label, errors)) continue;
    if (typeof repo.id !== 'string' || !/^[A-Za-z0-9._-]+$/u.test(repo.id)) errors.push(`${label}.id is invalid.`);
    if (repos.has(repo.id)) errors.push(`Duplicate repository id ${repo.id}.`);
    else repos.set(repo.id, repo);
    if (typeof repo.displayName !== 'string' || !repo.displayName.trim()) errors.push(`${label}.displayName is required.`);
    if (repo.remoteUrl !== null && typeof repo.remoteUrl !== 'string') errors.push(`${label}.remoteUrl must be string or null.`);
    if (typeof repo.commit !== 'string' || !SHA_RE.test(repo.commit)) errors.push(`${label}.commit must be a full SHA.`);
    if (!isDateTime(repo.collectedAt)) errors.push(`${label}.collectedAt must be a date-time.`);
    if (!['complete', 'partial', 'failed'].includes(repo.status)) errors.push(`${label}.status is invalid.`);
    if (typeof repo.accessGroup !== 'string' || !repo.accessGroup.trim()) errors.push(`${label}.accessGroup is required.`);
    if (!Number.isInteger(repo.fileCount) || repo.fileCount < 0) errors.push(`${label}.fileCount must be a non-negative integer.`);
    if ('errors' in repo && (!Array.isArray(repo.errors) || repo.errors.some((item) => typeof item !== 'string'))) errors.push(`${label}.errors must contain strings.`);
    if (repo.status === 'failed' && repo.fileCount !== 0) errors.push(`${label} failed status cannot claim indexed files.`);
  }
  const appIds = new Set();
  const appKeys = ['id', 'name', 'repositoryIds', 'status', 'reviewedBy', 'reviewedAt'];
  for (let i = 0; i < index.applications.length; i++) {
    const app = index.applications[i];
    const label = `applications[${i}]`;
    if (!checkExactKeys(app, appKeys, ['id', 'name', 'repositoryIds', 'status'], label, errors)) continue;
    if (typeof app.id !== 'string' || !/^[A-Za-z0-9._-]+$/u.test(app.id)) errors.push(`${label}.id is invalid.`);
    if (appIds.has(app.id)) errors.push(`Duplicate application id ${app.id}.`);
    appIds.add(app.id);
    if (typeof app.name !== 'string' || !app.name.trim()) errors.push(`${label}.name is required.`);
    if (!Array.isArray(app.repositoryIds) || app.repositoryIds.length === 0 || new Set(app.repositoryIds).size !== app.repositoryIds.length) {
      errors.push(`${label}.repositoryIds must be a non-empty unique array.`);
    } else {
      for (const id of app.repositoryIds) if (!repos.has(id)) errors.push(`${label} references unknown repository ${id}.`);
    }
    if (!['draft', 'approved'].includes(app.status)) errors.push(`${label}.status is invalid.`);
    if ('reviewedBy' in app && app.reviewedBy !== null && typeof app.reviewedBy !== 'string') errors.push(`${label}.reviewedBy is invalid.`);
    if ('reviewedAt' in app && app.reviewedAt !== null && !isDateTime(app.reviewedAt)) errors.push(`${label}.reviewedAt is invalid.`);
  }
  const chunkKeys = ['repositoryId', 'commit', 'path', 'startLine', 'endLine', 'blobSha', 'language', 'text'];
  const citations = new Set();
  const chunkIdentity = new Set();
  const chunkRangesByFile = new Map();
  for (let i = 0; i < index.chunks.length; i++) {
    const chunk = index.chunks[i];
    const label = `chunks[${i}]`;
    if (!checkExactKeys(chunk, chunkKeys, chunkKeys, label, errors)) continue;
    const repo = repos.get(chunk.repositoryId);
    if (!repo) errors.push(`${label} references unknown repository ${chunk.repositoryId}.`);
    else if (chunk.commit !== repo.commit) errors.push(`${label} commit does not match repository commit.`);
    if (typeof chunk.commit !== 'string' || !SHA_RE.test(chunk.commit)) errors.push(`${label}.commit must be a full SHA.`);
    if (typeof chunk.path !== 'string' || !safeRepoPath(chunk.path)) errors.push(`${label}.path is unsafe.`);
    else if (pathCategory(chunk.path, '100644', 'blob')) errors.push(`${label}.path is excluded by source-ingestion policy.`);
    if (!Number.isInteger(chunk.startLine) || chunk.startLine < 1 || !Number.isInteger(chunk.endLine) || chunk.endLine < chunk.startLine) errors.push(`${label} line range is invalid.`);
    if (typeof chunk.blobSha !== 'string' || !SHA_RE.test(chunk.blobSha)) errors.push(`${label}.blobSha must be a full SHA.`);
    if (typeof chunk.language !== 'string' || !chunk.language) errors.push(`${label}.language is required.`);
    if (typeof chunk.text !== 'string' || !chunk.text) errors.push(`${label}.text is required.`);
    if (typeof chunk.repositoryId === 'string' && typeof chunk.path === 'string' && typeof chunk.blobSha === 'string') {
      const fileKey = `${chunk.repositoryId}\0${chunk.commit}\0${chunk.path}\0${chunk.blobSha}`;
      citations.add(fileKey);
      const ranges = chunkRangesByFile.get(fileKey) ?? [];
      ranges.push([chunk.startLine, chunk.endLine]);
      chunkRangesByFile.set(fileKey, ranges);
      const key = `${fileKey}\0${chunk.startLine}\0${chunk.endLine}`;
      if (chunkIdentity.has(key)) errors.push(`${label} duplicates a chunk citation.`);
      chunkIdentity.add(key);
    }
  }
  const factKeys = ['repositoryId', 'commit', 'kind', 'name', 'value', 'evidence', 'extractor'];
  const factIdentity = new Set();
  for (let i = 0; i < index.facts.length; i++) {
    const fact = index.facts[i];
    const label = `facts[${i}]`;
    if (!checkExactKeys(fact, factKeys, factKeys, label, errors)) continue;
    const repo = repos.get(fact.repositoryId);
    if (!repo) errors.push(`${label} references unknown repository ${fact.repositoryId}.`);
    else if (fact.commit !== repo.commit) errors.push(`${label} commit does not match repository commit.`);
    if (typeof fact.commit !== 'string' || !SHA_RE.test(fact.commit)) errors.push(`${label}.commit must be a full SHA.`);
    if (typeof fact.kind !== 'string' || !fact.kind.trim()) errors.push(`${label}.kind is required.`);
    if (typeof fact.name !== 'string' || !fact.name.trim()) errors.push(`${label}.name is required.`);
    const validValue = isJsonValue(fact.value);
    if (!validValue) errors.push(`${label}.value must be a JSON value.`);
    if (!Array.isArray(fact.evidence) || fact.evidence.length === 0) errors.push(`${label}.evidence must not be empty.`);
    if (typeof fact.extractor !== 'string' || !fact.extractor.trim()) errors.push(`${label}.extractor is required.`);
    if (Array.isArray(fact.evidence)) {
      const evidenceKeys = new Set();
      for (const citation of fact.evidence) {
        if (!checkExactKeys(citation, ['path', 'startLine', 'endLine', 'blobSha'], ['path', 'startLine', 'endLine', 'blobSha'], `${label}.evidence`, errors)) continue;
        if (typeof citation.path !== 'string' || !safeRepoPath(citation.path)) errors.push(`${label} has an unsafe evidence path.`);
        if (!Number.isInteger(citation.startLine) || citation.startLine < 1 || !Number.isInteger(citation.endLine) || citation.endLine < citation.startLine) errors.push(`${label} has an invalid evidence line range.`);
        if (typeof citation.blobSha !== 'string' || !SHA_RE.test(citation.blobSha)) errors.push(`${label} has an invalid evidence blob SHA.`);
        const evidenceKey = `${citation.path}\0${citation.startLine}\0${citation.endLine}\0${citation.blobSha}`;
        if (evidenceKeys.has(evidenceKey)) errors.push(`${label} duplicates an evidence citation.`);
        evidenceKeys.add(evidenceKey);
        const key = `${fact.repositoryId}\0${fact.commit}\0${citation.path}\0${citation.blobSha}`;
        if (!citations.has(key)) errors.push(`${label} cites a file absent from chunks.`);
        const ranges = chunkRangesByFile.get(key) ?? [];
        let coveredThrough = citation.startLine - 1;
        for (const [start, end] of ranges) {
          if (start > coveredThrough + 1) break;
          if (end > coveredThrough) coveredThrough = end;
          if (coveredThrough >= citation.endLine) break;
        }
        if (ranges.length && coveredThrough < citation.endLine) {
          errors.push(`${label} evidence line range is not covered by a chunk.`);
        }
      }
    }
    if (validValue) {
      const key = `${fact.repositoryId}\0${fact.commit}\0${fact.kind}\0${fact.name}\0${stableJson(fact.value)}`;
      if (factIdentity.has(key)) errors.push(`${label} duplicates an existing fact.`);
      factIdentity.add(key);
    }
  }
  for (let i = 0; i < index.warnings.length; i++) if (typeof index.warnings[i] !== 'string') errors.push(`warnings[${i}] must be a string.`);
  for (const repo of index.repositories) {
    const hasWarnings = index.warnings.some((warning) => typeof warning === 'string' && warning.startsWith(`${repo.id}:`));
    if (hasWarnings && repo.status === 'complete') errors.push(`Repository ${repo.id} has warnings but is marked complete.`);
  }
  if (errors.length) throw new Error(`Invalid index:\n${errors.join('\n')}`);
  return index;
}

export { validateIndex };

function citationForFact(fact) {
  return fact.evidence.map((evidence) => ({
    repositoryId: fact.repositoryId,
    commit: fact.commit,
    path: evidence.path,
    startLine: evidence.startLine,
    endLine: evidence.endLine,
    blobSha: evidence.blobSha
  }));
}

export function searchIndex(index, { query, repositoryIds, maxResults } = {}) {
  validateIndex(index);
  if (typeof query !== 'string' || !query.trim()) throw new Error('query must be a non-empty string.');
  if (maxResults === undefined) maxResults = Math.max(index.chunks.length, 1);
  if (!Number.isSafeInteger(maxResults) || maxResults < 1) throw new RangeError('maxResults must be a positive safe integer.');
  if (repositoryIds !== undefined && (!Array.isArray(repositoryIds) || repositoryIds.some((id) => typeof id !== 'string'))) {
    throw new TypeError('repositoryIds must be an array of repository IDs.');
  }
  const allowed = repositoryIds ? new Set(repositoryIds) : null;
  if (allowed) {
    const knownIds = new Set(index.repositories.map((repo) => repo.id));
    for (const id of allowed) if (!knownIds.has(id)) throw new Error(`Unknown repository ${id}.`);
  }
  const phraseMatches = [...query.matchAll(/"([^"]+)"/gu)].map((match) => match[1].toLowerCase());
  const unquoted = query.replace(/"[^"]+"/gu, ' ').toLowerCase();
  const terms = unquoted.split(/\s+/u).filter(Boolean);
  const results = [];
  let totalMatches = 0;
  for (const chunk of index.chunks) {
    if (allowed && !allowed.has(chunk.repositoryId)) continue;
    const haystack = chunk.text.toLowerCase();
    if (!terms.every((term) => haystack.includes(term)) || !phraseMatches.every((phrase) => haystack.includes(phrase))) continue;
    totalMatches++;
    if (results.length < maxResults) {
      results.push({
        repositoryId: chunk.repositoryId,
        commit: chunk.commit,
        path: chunk.path,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        blobSha: chunk.blobSha,
        text: chunk.text
      });
    }
  }
  const knownIds = new Set(index.repositories.map((repo) => repo.id));
  const selectedWarnings = index.warnings.filter((warning) => {
    if (!allowed) return true;
    const scopedId = [...knownIds].find((id) => warning.startsWith(`${id}:`));
    return scopedId === undefined || allowed.has(scopedId);
  });
  const partialRepos = index.repositories.filter((repo) => (!allowed || allowed.has(repo.id)) && repo.status !== 'complete');
  const truncated = totalMatches > results.length;
  const status = truncated || partialRepos.length > 0 || selectedWarnings.length > 0 ? 'partial' : 'complete';
  return {
    query,
    status,
    coverage: {
      repositories: index.repositories.filter((repo) => !allowed || allowed.has(repo.id)).map(({ id, commit, status: repoStatus, accessGroup }) => ({ id, commit, status: repoStatus, accessGroup })),
      matchedChunks: totalMatches,
      returnedChunks: results.length,
      truncated,
      warnings: selectedWarnings
    },
    results
  };
}

export function repositorySummary(index, repositoryId) {
  validateIndex(index);
  const repository = index.repositories.find((repo) => repo.id === repositoryId);
  if (!repository) throw new Error(`Unknown repository ${repositoryId}.`);
  return {
    repository: { ...repository },
    facts: index.facts.filter((fact) => fact.repositoryId === repositoryId).map((fact) => ({
      kind: fact.kind, name: fact.name, value: fact.value, citations: citationForFact(fact), extractor: fact.extractor
    })),
    chunksIndexed: index.chunks.filter((chunk) => chunk.repositoryId === repositoryId).length,
    warnings: index.warnings.filter((warning) => warning.startsWith(`${repositoryId}:`))
  };
}

export function compareFact(index, { kind, name } = {}) {
  validateIndex(index);
  if (typeof kind !== 'string' || !kind.trim()) throw new Error('kind must be a non-empty string.');
  if (name !== undefined && typeof name !== 'string') throw new TypeError('name must be a string when provided.');
  return index.repositories.map((repository) => {
    const facts = index.facts.filter((fact) => fact.repositoryId === repository.id &&
      fact.kind === kind && (name === undefined || fact.name === name));
    return {
      repositoryId: repository.id,
      commit: repository.commit,
      accessGroup: repository.accessGroup,
      status: repository.status,
      known: facts.length > 0,
      values: facts.map((fact) => ({ name: fact.name, value: fact.value, citations: citationForFact(fact) })),
      missingMeans: 'unknown'
    };
  });
}
