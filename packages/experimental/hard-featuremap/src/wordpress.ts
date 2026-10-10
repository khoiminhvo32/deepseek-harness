/**
 * The WordPress profile: hook registrations and firings read from call sites,
 * the edges from a fired hook to its registered callbacks, and the entry
 * points a request can reach directly. The hook and registration function
 * names are WordPress's public API, not tunables.
 * @module @deepseek-ai/dsh-experimental-hard-featuremap/wordpress
 */

import { dirname } from 'node:path'
import type { HardCpgArg } from '@deepseek-ai/dsh-experimental-hard-cpg'
import { findMethod, lineage } from './model.ts'
import type { FactModel } from './model.ts'
import type { HardCallEdge } from './repair.ts'

/** Functions that register a hook callback: hook name first, callback second. */
const HOOK_REGISTRARS: ReadonlySet<string> = new Set(['add_action', 'add_filter'])
/** Functions that fire a hook: hook name first. */
const HOOK_FIRERS: ReadonlySet<string> = new Set([
  'do_action', 'do_action_ref_array', 'do_action_deprecated',
  'apply_filters', 'apply_filters_ref_array', 'apply_filters_deprecated',
])
/** The base class of the core REST controllers. */
const REST_CONTROLLER = 'WP_REST_Controller'
/** The route handlers a REST controller implements. */
const REST_HANDLERS: ReadonlySet<string> = new Set(['get_items', 'get_item', 'create_item', 'update_item', 'delete_item'])
/** WordPress access checks: every one a feature reaches is required. */
export const WORDPRESS_GUARDS: readonly string[] = [
  'current_user_can', 'user_can', 'author_can', 'current_user_can_for_site', 'is_user_logged_in', 'is_super_admin',
  'check_ajax_referer', 'check_admin_referer', 'wp_verify_nonce',
]
/** WordPress state writes: every one a feature reaches is required. */
export const WORDPRESS_MUTATIONS: readonly string[] = [
  'wp_insert_post', 'wp_update_post', 'wp_delete_post', 'wp_trash_post', 'wp_untrash_post', 'wp_publish_post',
  'add_post_meta', 'update_post_meta', 'delete_post_meta', 'add_option', 'update_option', 'delete_option',
  'add_user_meta', 'update_user_meta', 'delete_user_meta', 'wp_insert_user', 'wp_update_user', 'wp_delete_user', 'wp_set_password',
  'wp_set_post_terms', 'wp_set_object_terms', 'wp_insert_term', 'wp_update_term', 'wp_delete_term',
  'wp_insert_comment', 'wp_update_comment', 'wp_delete_comment', 'wp_set_comment_status',
  'wp_insert_attachment', 'wp_delete_attachment', 'wp_update_attachment_metadata', 'stick_post', 'unstick_post',
  'set_site_transient', 'set_transient', 'switch_theme', 'activate_plugin', 'deactivate_plugins', 'delete_plugins',
]

/** Hook-name prefixes that turn a registration into an entry point: kind and who may call it. */
const HOOK_ENTRY_PREFIXES: readonly { readonly prefix: string; readonly kind: HardEntryKind; readonly auth: HardEntryAuth }[] = [
  { prefix: 'wp_ajax_nopriv_', kind: 'ajax', auth: 'public' },
  { prefix: 'wp_ajax_', kind: 'ajax', auth: 'authenticated' },
  { prefix: 'admin_post_nopriv_', kind: 'admin-post', auth: 'public' },
  { prefix: 'admin_post_', kind: 'admin-post', auth: 'authenticated' },
]

/** One hook registration or firing; `name` is null when the hook name is computed. */
export interface HardHook {
  readonly site: number
  readonly op: 'register' | 'fire'
  readonly name: string | null
  /** The method a registration's callback names, when the facts resolve it. */
  readonly callback: string | null
  /** The callback argument's source text, for a registration. */
  readonly callbackText: string | null
  readonly caller: string
  readonly file: string
  readonly line: number | null
}

/**
 * How a request reaches an entry point: an admin-ajax action, an admin-post
 * action, a WordPress REST controller handler, a shortcode, a directly
 * requested script's top-level code, or a framework HTTP route.
 */
export type HardEntryKind = 'ajax' | 'admin-post' | 'rest' | 'shortcode' | 'script' | 'http'
/** Who the routing itself admits; `unknown` leaves the decision to the handler. */
export type HardEntryAuth = 'public' | 'authenticated' | 'unknown'

/**
 * One entry point; `handler` is null when the facts do not resolve the
 * callback, and `guards` lists the routing-level checks in front of it
 * (annotations, decorators, or middleware), in source order.
 */
export interface HardEntryPoint {
  readonly kind: HardEntryKind
  readonly key: string
  readonly handler: string | null
  readonly file: string
  readonly line: number | null
  readonly auth: HardEntryAuth
  readonly guards: readonly string[]
}

/**
 * The value of a PHP string literal's source text.
 * @param code - literal source text as Joern prints it.
 * @returns the string, or undefined for anything but a plain quoted string.
 */
export function phpString(code: string): string | undefined {
  const match = /^(["'])(.*)\1$/s.exec(code)
  if (match === null) return undefined
  const [, quote, body = ''] = match
  if (quote === '"' && /[$\\]/.test(body)) return undefined
  return quote === "'" ? body.replaceAll("\\'", "'").replaceAll('\\\\', '\\') : body
}

/**
 * The method a callback argument names: a closure or function reference, a
 * function name, a `Class::method` string, or an array of a class name or
 * `$this` and a method name.
 * @param model - the indexed facts.
 * @param arg - the callback argument summary.
 * @param caller - the method holding the registration, whose type `$this` means.
 * @returns the method id, or undefined when the facts do not resolve it.
 */
export function resolveCallback(model: FactModel, arg: HardCpgArg | undefined, caller: string): string | undefined {
  if (arg === undefined) return undefined
  if ('ref' in arg) return model.methods.has(arg.ref) ? arg.ref : undefined
  if ('lit' in arg) {
    const text = phpString(arg.lit)
    if (text === undefined) return undefined
    const separator = text.indexOf('::')
    if (separator >= 0) return findMethod(model, text.slice(0, separator), text.slice(separator + 2))
    return model.functions.has(text) ? text : undefined
  }
  if (!('arr' in arg) || arg.arr.length !== 2) return undefined
  const [target = '', methodCode = ''] = arg.arr
  const method = phpString(methodCode)
  if (method === undefined) return undefined
  const type = target === '$this' ? model.methods.get(caller)?.owner ?? undefined : phpString(target)
  return type === undefined ? undefined : findMethod(model, type, method)
}

/**
 * Every hook registration and firing in the model.
 * @param model - the indexed facts.
 * @returns hooks in call-site order.
 */
export function wordpressHooks(model: FactModel): HardHook[] {
  const hooks: HardHook[] = []
  model.calls.forEach((call, site) => {
    const register = HOOK_REGISTRARS.has(call.name)
    if (!register && !HOOK_FIRERS.has(call.name)) return
    const first = call.args[0]
    const name = first !== undefined && 'lit' in first ? phpString(first.lit) ?? null : null
    const callbackArg = call.args[1]
    hooks.push({
      site,
      op: register ? 'register' : 'fire',
      name,
      callback: register ? resolveCallback(model, callbackArg, call.caller) ?? null : null,
      callbackText: register && callbackArg !== undefined ? argText(callbackArg) : null,
      caller: call.caller,
      file: call.file,
      line: call.line,
    })
  })
  return hooks
}

/**
 * Edges from each firing with a literal name to every resolved callback registered under that name.
 * @param hooks - the model's hooks.
 * @returns one `hook` edge per firing and callback.
 */
export function hookEdges(hooks: readonly HardHook[]): HardCallEdge[] {
  const callbacks = new Map<string, Set<string>>()
  for (const hook of hooks) {
    if (hook.op !== 'register' || hook.name === null || hook.callback === null) continue
    const named = callbacks.get(hook.name) ?? new Set<string>()
    named.add(hook.callback)
    callbacks.set(hook.name, named)
  }
  const edges: HardCallEdge[] = []
  for (const hook of hooks) {
    if (hook.op !== 'fire' || hook.name === null) continue
    for (const callee of callbacks.get(hook.name) ?? []) {
      edges.push({ site: hook.site, caller: hook.caller, callee, file: hook.file, line: hook.line, source: 'hook' })
    }
  }
  return edges
}

/**
 * The entry points of a WordPress target.
 * @param model - the indexed facts.
 * @param hooks - the model's hooks.
 * @param scriptDirs - directories whose top-level PHP files are requested directly (`.` is the root).
 * @returns entry points: hook-routed actions, admin-ajax handlers by naming convention, shortcodes, REST handlers, then scripts.
 */
export function wordpressEntryPoints(model: FactModel, hooks: readonly HardHook[], scriptDirs: readonly string[]): HardEntryPoint[] {
  const entries: HardEntryPoint[] = []
  for (const hook of hooks) {
    const name = hook.name
    if (hook.op !== 'register' || name === null) continue
    const route = HOOK_ENTRY_PREFIXES.find(entry => name.startsWith(entry.prefix))
    if (route === undefined) continue
    const key = name.slice(route.prefix.length)
    entries.push({ kind: route.kind, key, handler: hook.callback, file: hook.file, line: hook.line, auth: route.auth, guards: [] })
  }
  // Core registers most admin-ajax actions in a loop with a computed hook name
  // and the handler `wp_ajax_` plus the action, so a free function named by
  // that convention is an action even when no literal registration names it.
  const handled = new Set(entries.map(entry => entry.handler))
  for (const method of model.methods.values()) {
    if (!model.functions.has(method.id) || handled.has(method.id)) continue
    const route = HOOK_ENTRY_PREFIXES.find(entry => entry.kind === 'ajax' && method.id.startsWith(entry.prefix))
    if (route === undefined) continue
    const key = method.id.slice(route.prefix.length)
    entries.push({ kind: 'ajax', key, handler: method.id, file: method.file, line: method.line, auth: route.auth, guards: [] })
  }
  model.calls.forEach((call) => {
    if (call.name !== 'add_shortcode') return
    const first = call.args[0]
    const tag = first !== undefined && 'lit' in first ? phpString(first.lit) : undefined
    if (tag === undefined) return
    const handler = resolveCallback(model, call.args[1], call.caller) ?? null
    entries.push({ kind: 'shortcode', key: tag, handler, file: call.file, line: call.line, auth: 'public', guards: [] })
  })
  for (const method of model.methods.values()) {
    if (method.owner === null || !REST_HANDLERS.has(method.name)) continue
    if (!lineage(model, method.owner).slice(1).includes(REST_CONTROLLER)) continue
    entries.push({ kind: 'rest', key: method.id, handler: method.id, file: method.file, line: method.line, auth: 'unknown', guards: [] })
  }
  const dirs = new Set(scriptDirs)
  for (const path of new Set(model.files)) {
    if (!path.endsWith('.php') || !dirs.has(dirname(path))) continue
    entries.push({ kind: 'script', key: path, handler: model.fileLevel.get(path) ?? null, file: path, line: null, auth: 'unknown', guards: [] })
  }
  return entries
}

function argText(arg: HardCpgArg): string {
  if ('lit' in arg) return arg.lit
  if ('arr' in arg) return `array(${arg.arr.join(', ')})`
  if ('ref' in arg) return arg.ref
  return arg.code
}
