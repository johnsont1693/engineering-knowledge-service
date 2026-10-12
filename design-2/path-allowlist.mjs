function escapeRegex(character) {
  return /[|\\{}()[\]^$+?.]/.test(character) ? `\\${character}` : character;
}

export function compileRepoPathPattern(pattern) {
  if (typeof pattern !== "string" || !pattern || pattern.startsWith("/") ||
      pattern.includes("\\") || pattern.includes(":") ||
      /[\u0000-\u001f\u007f]/u.test(pattern) ||
      pattern.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("Repository path allowlist patterns must be normalized, repository-relative paths.");
  }
  let expression = "^";
  for (let i = 0; i < pattern.length; i++) {
    const character = pattern[i];
    if (character === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          expression += "(?:.*/)?";
          i += 2;
        } else {
          expression += ".*";
          i++;
        }
      } else {
        expression += "[^/]*";
      }
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += escapeRegex(character);
    }
  }
  return new RegExp(`${expression}$`, "u");
}

export function isAllowedRepoPath(file, patterns) {
  if (typeof file !== "string" || file.startsWith("/") || file.includes("\\") ||
      file.includes(":") || /[\u0000-\u001f\u007f]/u.test(file) ||
      file.split("/").some(part => !part || part === "." || part === "..")) return false;
  return patterns.some(pattern => compileRepoPathPattern(pattern).test(file));
}
