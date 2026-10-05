/**
 * Deterministic coverage-module enumeration over tracked target paths:
 * pure grouping and exclusion over repo-relative paths, with all git I/O
 * owned by the mission service.
 * @module
 */

/**
 * Group tracked file paths into the deterministic module list. Each file
 * contributes the first `moduleDepth` segments of its containing directory;
 * a repository-root file contributes `.`. The result is sorted and
 * deduplicated, so the same tracked tree always yields the same modules.
 * @param paths - tracked file paths, repo-relative, forward-slash separated.
 * @param moduleDepth - directory segments per module, 1 through 6.
 * @returns the sorted, deduplicated module names.
 */
export function modulesFromPaths(paths: readonly string[], moduleDepth: number): readonly string[] {
  const modules = new Set<string>()
  for (const path of paths) {
    const cut = path.lastIndexOf('/')
    const directory = cut === -1 ? '' : path.slice(0, cut)
    const segments = directory === '' ? [] : directory.split('/')
    modules.add(segments.length === 0 ? '.' : segments.slice(0, moduleDepth).join('/'))
  }
  return [...modules].sort()
}

/**
 * Filter tracked file paths through root-anchored exclusion globs. A glob
 * matches the whole repo-relative path: `*` stays within one segment, `?`
 * matches one character, a `**` before a slash spans zero or more leading
 * directories, and a trailing `**` matches everything below its directory.
 * @param paths - tracked file paths, repo-relative, forward-slash separated.
 * @param globs - the exclusion globs to apply.
 * @returns the paths no glob matches, preserving input order.
 */
export function filterExcludedPaths(paths: readonly string[], globs: readonly string[]): readonly string[] {
  const patterns = globs.map(globToRegExp)
  return paths.filter(path => !patterns.some(pattern => pattern.test(path)))
}

/** Translate one root-anchored glob into a whole-path regular expression. */
function globToRegExp(glob: string): RegExp {
  let source = '^'
  let index = 0
  while (index < glob.length) {
    if (glob.startsWith('**/', index)) {
      source += '(?:[^/]+/)*'
      index += 3
    } else if (glob.startsWith('**', index)) {
      source += '.*'
      index += 2
    } else if (glob.startsWith('*', index)) {
      source += '[^/]*'
      index += 1
    } else if (glob.startsWith('?', index)) {
      source += '[^/]'
      index += 1
    } else {
      source += (glob[index] as string).replace(/[$()+.[\]^{|}\\]/g, '\\$&')
      index += 1
    }
  }
  return new RegExp(`${source}$`, 'u')
}
