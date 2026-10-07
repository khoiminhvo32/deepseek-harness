/**
 * Deterministic coverage-module enumeration over tracked target paths:
 * pure grouping and exclusion over repo-relative paths, with all git I/O
 * owned by the mission service.
 * @module
 */

/**
 * File extensions that cannot carry executable code. Deliberately
 * conservative: an unknown extension counts as code, so the inert-module
 * screen can only under-screen (toward more work), never over-screen a
 * module out of the matrix.
 *
 * Deliberately NOT inert, and why: `.svg` can carry `<script>` and is a real
 * XSS vector; `.html`, `.json`, `.yml`, `.yaml`, and `.toml` are
 * configuration and template surface; `.csv` is a formula-injection vector;
 * `.lock` is the very surface of the dependencies class; gettext catalogs
 * (`.po`, `.pot`, `.mo`) feed translated strings into rendered pages, where
 * an unescaped echo of a translation is an XSS vector; and extensionless
 * files (Dockerfile, Makefile) are code.
 */
export const INERT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.rst',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.webp',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
])

/** One tracked file at the pinned commit, with git's binary classification. */
export interface TrackedFile {
  /** Repo-relative, forward-slash path. */
  readonly path: string
  /** Whether git classifies the content as binary — what `grep -I` skips. */
  readonly binary: boolean
}

/**
 * The lowercase extension of one path's basename, or `''` when the basename
 * has none. A leading dot alone (`.gitignore`) is a name, not an extension,
 * and a dotted directory never lends its dot to an extensionless file.
 * @param path - a repo-relative, forward-slash path.
 * @returns the extension including its dot, or the empty string.
 */
export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

/**
 * The coverage module one tracked file belongs to: the first `moduleDepth`
 * segments of its containing directory, or `.` for a repository-root file.
 * @param path - a tracked file path, repo-relative, forward-slash separated.
 * @param moduleDepth - directory segments per module, 1 through 6.
 * @returns the module name.
 */
export function moduleOfPath(path: string, moduleDepth: number): string {
  const cut = path.lastIndexOf('/')
  const directory = cut === -1 ? '' : path.slice(0, cut)
  const segments = directory === '' ? [] : directory.split('/')
  return segments.length === 0 ? '.' : segments.slice(0, moduleDepth).join('/')
}

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
  for (const path of paths) modules.add(moduleOfPath(path, moduleDepth))
  return [...modules].sort()
}

/**
 * The modules where EVERY tracked file carries an inert extension: no code,
 * so no module-class attack surface. A module with no files is never inert —
 * a vacuous "all files inert" must not screen anything out. The result is
 * sorted and deduplicated.
 * @param paths - tracked file paths, repo-relative, forward-slash separated.
 * @param moduleDepth - directory segments per module, 1 through 6.
 * @param inertExtensions - extensions that cannot carry executable code.
 * @returns the sorted, deduplicated inert module names.
 */
export function inertModulesFromPaths(
  paths: readonly string[],
  moduleDepth: number,
  inertExtensions: ReadonlySet<string>,
): readonly string[] {
  const filesByModule = new Map<string, string[]>()
  for (const path of paths) {
    const module = moduleOfPath(path, moduleDepth)
    const files = filesByModule.get(module)
    if (files === undefined) filesByModule.set(module, [path])
    else files.push(path)
  }
  const inert: string[] = []
  for (const [module, files] of filesByModule) {
    const everyFileInert = files.length > 0 && files.every(file => inertExtensions.has(extensionOf(file)))
    if (everyFileInert) inert.push(module)
  }
  return inert.sort()
}

/**
 * The modules the coverage cross-check cannot screen: any module holding a
 * tracked file that is neither inert nor screenable — a binary (whatever its
 * extension, because `grep -I` skips it by content), or a code file whose
 * extension the fixed pattern tables were not written for. One such file is
 * enough; a module mixing a covered language with an uncovered one is
 * unscreened. An inert-only module is never listed. The result is sorted and
 * deduplicated.
 * @param files - the tracked files at the pinned commit with their binary classification.
 * @param moduleDepth - directory segments per module, 1 through 6.
 * @param inertExtensions - extensions that cannot carry executable code.
 * @param screenedExtensions - extensions the fixed pattern tables were written for.
 * @returns the sorted, deduplicated unscreened module names.
 */
export function unscreenedModulesFromFiles(
  files: readonly TrackedFile[],
  moduleDepth: number,
  inertExtensions: ReadonlySet<string>,
  screenedExtensions: ReadonlySet<string>,
): readonly string[] {
  const unscreened = new Set<string>()
  for (const file of files) {
    const extension = extensionOf(file.path)
    if (inertExtensions.has(extension)) continue
    if (file.binary || !screenedExtensions.has(extension)) unscreened.add(moduleOfPath(file.path, moduleDepth))
  }
  return [...unscreened].sort()
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
