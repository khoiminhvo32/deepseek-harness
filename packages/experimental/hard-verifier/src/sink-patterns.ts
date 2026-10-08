/**
 * Fixed pattern protocol for the deterministic coverage cross-check: one
 * extended-regex alternation per bug class, joined into a single
 * `grep -rInE` expression over the swept module. Patterns are security
 * invariants, not tunables: they name the mechanical source-to-sink shapes
 * each class guards, so a `cleared` cell whose module still matches an
 * undeclared sink reopens with the match as evidence. `GUARDED_SURFACE_PATTERNS`
 * holds the two absence classes whose patterns name the guarded surface — the
 * exported operation — instead of the guard, and `surfaceOperands` reduces a
 * matched line back to the operation names the model must have declared.
 * @module
 */

/**
 * File extensions the fixed pattern tables were written for: the
 * JavaScript/TypeScript family, Python, Java, and PHP, whose shapes include
 * the WordPress database, HTTP, redirect, authentication, and hook APIs.
 * Covered means a table names
 * this language's sink and surface shapes, not that the table is complete for
 * it. The mission records a module holding any tracked code file outside this
 * set — or any binary, which `grep -I` skips whatever its extension — as
 * unscreened: the cross-check grep is silent there, so it can neither re-open
 * nor support a clear.
 */
export const SCREENED_EXTENSIONS: ReadonlySet<string> = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.mts',
  '.cts',
  '.tsx',
  '.py',
  '.java',
  '.php',
])

/** Per-class grep -E alternations naming that class's sink shapes. */
export const SINK_PATTERNS: Readonly<Record<string, readonly string[]>> = {
  sqli: [
    '(execute|executemany|query|rawQuery)\\(',
    'createStatement|prepareStatement',
    '(SELECT|INSERT|UPDATE|DELETE).*(\\+|\\$\\{|%s|f")',
    '\\$wpdb->(query|get_results|get_row|get_var|get_col)\\(|mysqli?_query\\(',
    '(SELECT|INSERT|UPDATE|DELETE)[^;]*\\$[A-Za-z_]',
  ],
  xss: [
    'innerHTML|outerHTML|document\\.write',
    'dangerouslySetInnerHTML',
    'insertAdjacentHTML',
    '(echo|print|printf)[^;]*\\$_(GET|POST|REQUEST|COOKIE|SERVER)',
    '<\\?=[^?]*\\$',
  ],
  cmdi: [
    'system\\(|popen\\(|exec\\(|execSync|spawn(Sync)?\\(',
    'Runtime\\.getRuntime\\(\\)\\.exec',
    'subprocess\\.(call|run|Popen)',
    'os\\.(system|popen)',
    'shell_exec\\(|passthru\\(|proc_open\\(|pcntl_exec\\(',
  ],
  'path-traversal': [
    '(readFile|writeFile|open|createReadStream|createWriteStream)\\(',
    'File\\(|FileInputStream|new File\\(',
    'path\\.(join|resolve)\\(.*(req\\.|params\\.|user)',
    '(include|require)(_once)?[ (][^;]*\\$',
    '(file_get_contents|file_put_contents|fopen|readfile|unlink|move_uploaded_file|opendir|scandir)\\(',
  ],
  'open-redirect': [
    '(redirect|sendRedirect|Location:)',
    'window\\.location(\\.href)?\\s*=',
    'res\\.redirect',
    'wp_(safe_)?redirect\\(',
  ],
  deserialization: [
    'pickle\\.loads|yaml\\.load\\(|unserialize\\(',
    'ObjectInputStream|readObject\\(',
    'JSON\\.parse\\(.*(req|user|input)',
    'phar://',
  ],
  ssrf: [
    '(fetch|urlopen|requests\\.(get|post)|axios(\\.get|\\.post)?|http\\.get|HttpClient)',
    'new URL\\(.*(req|user|param)',
    'wp_(safe_)?remote_(get|post|head|request)\\(|curl_exec\\(',
  ],
  authn: [
    '(password|passwd|secret|token)\\s*==|\\.equals\\(.*(password|token)',
    'jwt\\.(decode|verify)|verify\\(',
    'session\\[|getSession',
    'wp_check_password\\(|wp_validate_auth_cookie\\(|hash_equals\\(',
  ],
  'authn-bypass': [
    'isAuthenticated|is_logged_in|requireAuth|login_required',
    'verifyToken|decodeToken',
  ],
  'login-bypass': [
    '(login|authenticate)\\(',
    'comparePassword|checkPassword|bcrypt\\.compare',
    'DEFAULT_(ADMIN|USER)|default.{0,12}credential',
    'wp_signon\\(|wp_authenticate\\(|wp_set_auth_cookie\\(|wp_set_current_user\\(',
  ],
  'oauth-bypass': [
    '(redirect_uri|state|nonce|pkce|code_verifier)',
    '(exchange|token_endpoint|authorize\\?)',
  ],
  session: [
    'session\\.(id|regenerate|fixation)|Set-Cookie',
    '(jsessionid|phpsessionid|session_id)',
    'session_start\\(|setcookie\\(',
  ],
  authz: [
    '(isAdmin|hasRole|checkPermission|can\\(|authorize)\\(',
    'role.{0,20}(admin|root)|@PreAuthorize',
  ],
  'crypto-misuse': [
    '(MD5|SHA1|DES|ECB|iv\\s*=)|createCipheriv\\(',
    'Math\\.random\\(',
    '(encrypt|decrypt)\\(',
    'md5\\(|sha1\\(|mt_rand\\(|[^_]rand\\(|uniqid\\(',
  ],
  misconfig: [
    '(DEBUG\\s*=\\s*True|debug\\s*=\\s*true)',
    'allow_origins?\\s*=|CORS',
    '(secret_key|api_key)\\s*=\\s*["\']',
    'WP_DEBUG|display_errors|ini_set\\(',
  ],
  dependencies: [
    '(require|import)\\(.*(http:|git+)',
    '"(resolve|dependencies)"\\s*:',
    '"require(-dev)?"\\s*:',
  ],
  race: [
    '(setTimeout|setInterval)\\(',
    '(new Thread|asyncio\\.(create_task|ensure_future)|go func|pthread_create)',
    '(lock|mutex|acquire|synchronized)',
    'flock\\(|sem_acquire\\(',
  ],
}

/**
 * Extended-regex alternations naming the exported surface itself — operations
 * that leave the module, not the guards over them. Shared by the guarded-surface
 * classes below; the approximate shape is deliberate, a real call graph is out
 * of scope.
 */
const EXPORTED_SURFACE_PATTERNS: readonly string[] = [
  'export (async )?function \\w+',
  'export const \\w+ =',
  'module\\.exports',
  'exports\\.\\w+ =',
  '(app|router)\\.(get|post|put|delete|patch)\\(',
  '@(Get|Post|Put|Delete|RequestMapping)\\(',
  'register_rest_route\\(',
  'add_action\\([^,]*(wp_ajax_|admin_post_)',
  'add_shortcode\\(',
]

/**
 * Bug classes where the bug is the ABSENCE of a guard: the pattern names the
 * surface that needs protecting (the exported operation), not the guard. The
 * opposite reading of `SINK_PATTERNS`, whose patterns name the dangerous site
 * itself. For these classes a cross-check match is an operation the model must
 * have declared a guard for — or declared deliberately unguarded, with the
 * reason. Zero matches is silence: the table recognizes no exported operation,
 * which re-opens nothing and certifies nothing.
 */
export const GUARDED_SURFACE_PATTERNS: Readonly<Record<string, readonly string[]>> = {
  authz: EXPORTED_SURFACE_PATTERNS,
  'authn-bypass': EXPORTED_SURFACE_PATTERNS,
}

/** JS regexes that extract the operation name from one matched surface line; first match wins. */
const OPERAND_PATTERNS: readonly { readonly regex: RegExp; readonly operand: (match: RegExpExecArray) => readonly string[] }[] = [
  { regex: /export\s+(?:async\s+)?function\s+(\w+)/, operand: match => [String(match[1])] },
  { regex: /export\s+const\s+(\w+)\s*=/, operand: match => [String(match[1])] },
  { regex: /exports\.(\w+)\s*=/, operand: match => [String(match[1])] },
  { regex: /(?:app|router)\.(?:get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]/, operand: match => [String(match[1])] },
  { regex: /@(Get|Post|Put|Delete|RequestMapping)(?:\(\s*['"`]?([^'"`\s)]*))?/, operand: match => match[2] === undefined || match[2] === '' ? [String(match[1])] : [match[2]] },
  // WordPress: the hook names an AJAX or admin-post action; a literal REST route names itself.
  { regex: /add_action\(\s*['"]((?:wp_ajax_|admin_post_)[\w-]+)['"]/, operand: match => [String(match[1])] },
  { regex: /add_shortcode\(\s*['"]([\w-]+)['"]/, operand: match => [String(match[1])] },
  {
    // A route whose name is built from variables, or written on the following lines,
    // has no literal name here, so its location stands for it.
    regex: /^(.+?):(\d+):.*register_rest_route\((?:\s*[^,]+,\s*['"]([^'"]+)['"])?/,
    operand: match => [match[3] ?? `${String(match[1])}:${String(match[2])}`],
  },
  // An action hook whose name is built at run time is likewise named by its location.
  { regex: /^(.+?):(\d+):.*add_action\(/, operand: match => [`${String(match[1])}:${String(match[2])}`] },
  {
    regex: /module\.exports\s*=\s*\{([^}]*)\}/,
    operand: match => String(match[1])
      .split(',')
      .map(name => String(name.trim().split(/[:\s]/u)[0]))
      .filter(name => /^\w+$/u.test(name)),
  },
]

/**
 * Name the exported operations one matched surface line declares, so the
 * cross-check can compare them with the operations the model declared. A line
 * whose shape no extractor recognizes falls back to the whole trimmed line.
 * @param line - one `grep` match line, typically `path:line:content`.
 * @returns the operation names to check against the model's declarations.
 */
export function surfaceOperands(line: string): readonly string[] {
  for (const { regex, operand } of OPERAND_PATTERNS) {
    const match = regex.exec(line)
    if (match !== null) {
      const named = operand(match).filter(name => name.length > 0)
      if (named.length > 0) return named
    }
  }
  return [line.trim()]
}
