/**
 * Fixed sink-pattern protocol for the deterministic coverage cross-check:
 * one extended-regex alternation per bug class, joined into a single
 * `grep -rInE` expression over the swept module. Patterns are security
 * invariants, not tunables: they name the mechanical source-to-sink shapes
 * each class guards, so a `cleared` cell whose module still matches an
 * undeclared sink reopens with the match as evidence.
 * @module
 */

/** Per-class grep -E alternations naming that class's sink shapes. */
export const SINK_PATTERNS: Readonly<Record<string, readonly string[]>> = {
  sqli: [
    '(execute|executemany|query|rawQuery)\\(',
    'createStatement|prepareStatement',
    '(SELECT|INSERT|UPDATE|DELETE)[^\n]*(\\+|\\$\\{|%s|f")',
  ],
  xss: [
    'innerHTML|outerHTML|document\\.write',
    'dangerouslySetInnerHTML',
    'insertAdjacentHTML',
  ],
  cmdi: [
    'system\\(|popen\\(|exec\\(|execSync|spawn(Sync)?\\(',
    'Runtime\\.getRuntime\\(\\)\\.exec',
    'subprocess\\.(call|run|Popen)',
    'os\\.(system|popen)',
  ],
  'path-traversal': [
    '(readFile|writeFile|open|createReadStream|createWriteStream)\\(',
    'File\\(|FileInputStream|new File\\(',
    'path\\.(join|resolve)\\([^\n]*(req\\.|params\\.|user)',
  ],
  'open-redirect': [
    '(redirect|sendRedirect|Location:)',
    'window\\.location(\\.href)?\\s*=',
    'res\\.redirect',
  ],
  deserialization: [
    'pickle\\.loads|yaml\\.load\\(|unserialize\\(',
    'ObjectInputStream|readObject\\(',
    'JSON\\.parse\\([^\n]*(req|user|input)',
  ],
  ssrf: [
    '(fetch|urlopen|requests\\.(get|post)|axios(\\.get|\\.post)?|http\\.get|HttpClient)',
    'new URL\\([^\n]*(req|user|param)',
  ],
  authn: [
    '(password|passwd|secret|token)\\s*==|\\.equals\\([^\n]*(password|token)',
    'jwt\\.(decode|verify)|verify\\(',
    'session\\[|getSession',
  ],
  'authn-bypass': [
    'isAuthenticated|is_logged_in|requireAuth|login_required',
    'verifyToken|decodeToken',
  ],
  'login-bypass': [
    '(login|authenticate)\\(',
    'comparePassword|checkPassword|bcrypt\\.compare',
    'DEFAULT_(ADMIN|USER)|default.{0,12}credential',
  ],
  'oauth-bypass': [
    '(redirect_uri|state|nonce|pkce|code_verifier)',
    '(exchange|token_endpoint|authorize\\?)',
  ],
  session: [
    'session\\.(id|regenerate|fixation)|Set-Cookie',
    '(jsessionid|phpsessionid|session_id)',
  ],
  authz: [
    '(isAdmin|hasRole|checkPermission|can\\(|authorize)\\(',
    'role.{0,20}(admin|root)|@PreAuthorize',
  ],
  'crypto-misuse': [
    '(MD5|SHA1|DES|ECB|iv\\s*=)|createCipheriv\\(',
    'Math\\.random\\(',
    '(encrypt|decrypt)\\(',
  ],
  misconfig: [
    '(DEBUG\\s*=\\s*True|debug\\s*=\\s*true)',
    'allow_origins?\\s*=|CORS',
    '(secret_key|api_key)\\s*=\\s*["\']',
  ],
  dependencies: [
    '(require|import)\\([^\n]*(http:|git+)',
    '"(resolve|dependencies)"\\s*:',
  ],
  race: [
    '(setTimeout|setInterval)\\(',
    '(new Thread|asyncio\\.(create_task|ensure_future)|go func|pthread_create)',
    '(lock|mutex|acquire|synchronized)',
  ],
}
