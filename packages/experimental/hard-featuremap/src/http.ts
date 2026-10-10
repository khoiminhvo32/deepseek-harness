/**
 * HTTP route profiles for web frameworks. Each profile reads the routes a
 * framework declares (annotations, decorators, or routing calls), the handler
 * each route reaches, and the routing-level guards in front of it. The
 * annotation, decorator, and routing function names are each framework's
 * public API, not tunables.
 * @module @deepseek-ai/dsh-experimental-hard-featuremap/http
 */

import type { HardCpgAnnotation, HardCpgArg } from '@deepseek-ai/dsh-experimental-hard-cpg'
import { findMethod } from './model.ts'
import type { CallFact, FactModel, MethodFact } from './model.ts'
import { phpString } from './wordpress.ts'
import type { HardEntryAuth, HardEntryPoint } from './wordpress.ts'

/** A framework whose HTTP routes have a profile. */
export type HardHttpFramework = 'laravel' | 'spring' | 'aspnet' | 'flask' | 'fastapi' | 'express'

/** HTTP verbs by the annotation, decorator, or routing function that declares them; `ANY` when the declaration does not fix one. */
const SPRING_MAPPINGS: Readonly<Record<string, string>> = {
  GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT', DeleteMapping: 'DELETE', PatchMapping: 'PATCH', RequestMapping: 'ANY',
}
const SPRING_GUARDS: ReadonlySet<string> = new Set(['PreAuthorize', 'PostAuthorize', 'Secured', 'RolesAllowed'])
const ASPNET_MAPPINGS: Readonly<Record<string, string>> = {
  HttpGet: 'GET', HttpPost: 'POST', HttpPut: 'PUT', HttpDelete: 'DELETE', HttpPatch: 'PATCH', Route: 'ANY',
}
const PYTHON_ROUTES: Readonly<Record<string, string>> = {
  route: 'ANY', api_route: 'ANY', get: 'GET', post: 'POST', put: 'PUT', delete: 'DELETE', patch: 'PATCH', websocket: 'WEBSOCKET',
}
/** A Python decorator whose name reads as an access check. */
const PYTHON_GUARD = /(?:_required$|^requires?_|login|auth|permission|role|admin)/i
const ROUTING_CALLS: Readonly<Record<string, string>> = {
  get: 'GET', post: 'POST', put: 'PUT', delete: 'DELETE', patch: 'PATCH', options: 'OPTIONS', all: 'ANY', any: 'ANY',
}
const LARAVEL_ROUTE = 'Illuminate\\Support\\Facades\\Route.'

/**
 * The HTTP entry points of the given frameworks.
 * @param model - the indexed facts.
 * @param frameworks - the frameworks to read.
 * @returns entry points of kind `http`, keyed `VERB path`, framework by framework.
 */
export function httpEntryPoints(model: FactModel, frameworks: readonly HardHttpFramework[]): HardEntryPoint[] {
  const entries: HardEntryPoint[] = []
  const read = new Set(frameworks)
  if (read.has('spring')) entries.push(...springRoutes(model))
  if (read.has('aspnet')) entries.push(...aspnetRoutes(model))
  if (read.has('flask') || read.has('fastapi')) entries.push(...pythonRoutes(model))
  if (read.has('express')) entries.push(...expressRoutes(model))
  if (read.has('laravel')) entries.push(...laravelRoutes(model))
  return entries
}

function springRoutes(model: FactModel): HardEntryPoint[] {
  const entries: HardEntryPoint[] = []
  for (const method of model.methods.values()) {
    const found = mappingOf(method.annotations, SPRING_MAPPINGS)
    if (found === undefined) continue
    const [mapping, verb] = found
    const typeAnnotations = typeAnnotationsOf(model, method)
    const prefix = typeAnnotations.find(a => a.name === 'RequestMapping')
    const all = [...typeAnnotations, ...method.annotations]
    const guards = all.filter(a => SPRING_GUARDS.has(a.name)).map(guardText)
    const open = all.some(a => a.name === 'PermitAll')
    entries.push(route(verb, joinPath(firstArg(prefix), firstArg(mapping)), method, guards, open))
  }
  return entries
}

function aspnetRoutes(model: FactModel): HardEntryPoint[] {
  const entries: HardEntryPoint[] = []
  for (const method of model.methods.values()) {
    const found = mappingOf(method.annotations, ASPNET_MAPPINGS)
    if (found === undefined) continue
    const [mapping, verb] = found
    const typeAnnotations = typeAnnotationsOf(model, method)
    const controller = (method.owner === null ? '' : model.types.get(method.owner)?.name ?? '').replace(/Controller$/, '')
    const expand = (path: string): string => path.replaceAll('[controller]', controller).replaceAll('[action]', method.name)
    const prefix = expand(quoted(typeAnnotations.find(a => a.name === 'Route')?.code))
    const own = expand(quoted(mapping.code))
    const path = own.startsWith('/') || own.startsWith('~/') ? own.replace(/^~/, '') : joinPath(prefix, own)
    const all = [...typeAnnotations, ...method.annotations]
    const guards = all.filter(a => a.name === 'Authorize').map(a => a.code)
    const open = method.annotations.some(a => a.name === 'AllowAnonymous')
    entries.push(route(verb, path, method, guards, open))
  }
  return entries
}

function pythonRoutes(model: FactModel): HardEntryPoint[] {
  const entries: HardEntryPoint[] = []
  for (const method of model.methods.values()) {
    const found = mappingOf(method.annotations.filter(a => unquote(a.args[0] ?? '').startsWith('/')), PYTHON_ROUTES)
    if (found === undefined) continue
    const [decorator, verb] = found
    const guards = method.annotations.filter(a => a !== decorator && PYTHON_GUARD.test(a.name)).map(a => a.name)
    entries.push(route(verb, firstArg(decorator), method, guards, false))
  }
  return entries
}

function expressRoutes(model: FactModel): HardEntryPoint[] {
  const entries: HardEntryPoint[] = []
  for (const call of model.calls) {
    const verb = ROUTING_CALLS[call.name]
    const [first, ...rest] = call.args
    const [handlerArg] = rest.slice(-1)
    if (verb === undefined || call.dispatch !== 'dynamic' || first === undefined || !('lit' in first) || handlerArg === undefined) continue
    const path = unquote(first.lit)
    if (!path.startsWith('/')) continue
    const guards = rest.slice(0, -1).map(argName)
    const handler = sameFileFunction(model, call, handlerArg)
    entries.push(routeAt(verb, path, handler, call, guards, false))
  }
  return entries
}

function laravelRoutes(model: FactModel): HardEntryPoint[] {
  const middleware = new Map<string, string[]>()
  for (const call of model.calls) {
    if (call.name !== 'middleware' || !call.target.startsWith(LARAVEL_ROUTE)) continue
    const names = call.args.flatMap(arg => 'lit' in arg ? [unquote(arg.lit)] : [])
    middleware.set(`${call.file}:${call.line}`, names)
  }
  const entries: HardEntryPoint[] = []
  for (const call of model.calls) {
    const verb = ROUTING_CALLS[call.name]
    if (verb === undefined || call.target !== `${LARAVEL_ROUTE}${call.name}`) continue
    const [first, handlerArg] = call.args
    if (first === undefined || !('lit' in first)) continue
    const handler = laravelHandler(model, handlerArg)
    const guards = middleware.get(`${call.file}:${call.line}`) ?? []
    entries.push(routeAt(verb, joinPath('', unquote(first.lit)), handler, call, guards, false))
  }
  return entries
}

function laravelHandler(model: FactModel, arg: HardCpgArg | undefined): string | null {
  if (arg === undefined) return null
  if ('ref' in arg) return model.methods.has(arg.ref) ? arg.ref : null
  if ('arr' in arg && arg.arr.length === 2) {
    const [typeCode = '', methodCode = ''] = arg.arr
    const type = typeCode.replace(/(?:\.|::)class$/, '')
    const method = phpString(methodCode)
    return method === undefined ? null : findMethod(model, type, method) ?? null
  }
  if ('lit' in arg) {
    const [type, method] = (phpString(arg.lit) ?? '').split('@')
    if (method === undefined) return null
    const known = [...model.types.keys()].find(id => id === type || id.endsWith(`\\${type}`))
    return known === undefined ? null : findMethod(model, known, method) ?? null
  }
  return null
}

/** The function a routing call's handler argument names: a referenced closure, or a function of that name in the same file. */
function sameFileFunction(model: FactModel, call: CallFact, arg: HardCpgArg): string | null {
  if ('ref' in arg) return model.methods.has(arg.ref) ? arg.ref : null
  if (!('code' in arg)) return null
  for (const method of model.methods.values()) {
    if (method.file === call.file && method.name === arg.code && !method.fileLevel) return method.id
  }
  return null
}

/** The first annotation the table maps to a verb, with that verb. */
function mappingOf(
  annotations: readonly HardCpgAnnotation[],
  table: Readonly<Record<string, string>>,
): [HardCpgAnnotation, string] | undefined {
  for (const annotation of annotations) {
    const verb = table[annotation.name]
    if (verb !== undefined) return [annotation, verb]
  }
  return undefined
}

function typeAnnotationsOf(model: FactModel, method: MethodFact): readonly HardCpgAnnotation[] {
  return method.owner === null ? [] : model.types.get(method.owner)?.annotations ?? []
}

function route(verb: string, path: string, method: MethodFact, guards: string[], open: boolean): HardEntryPoint {
  return { kind: 'http', key: `${verb} ${path}`, handler: method.id, file: method.file, line: method.line, auth: authOf(guards, open), guards }
}

function routeAt(verb: string, path: string, handler: string | null, call: CallFact, guards: string[], open: boolean): HardEntryPoint {
  return { kind: 'http', key: `${verb} ${path}`, handler, file: call.file, line: call.line, auth: authOf(guards, open), guards }
}

function authOf(guards: readonly string[], open: boolean): HardEntryAuth {
  if (open) return 'public'
  return guards.length > 0 ? 'authenticated' : 'unknown'
}

function guardText(annotation: HardCpgAnnotation): string {
  return annotation.args.length > 0 ? `${annotation.name}(${annotation.args.join(', ')})` : annotation.name
}

function firstArg(annotation: HardCpgAnnotation | undefined): string {
  return unquote(annotation?.args[0] ?? '')
}

/** The first double-quoted string in an annotation's source text, or empty. */
function quoted(code: string | undefined): string {
  return /"([^"]*)"/.exec(code ?? '')?.[1] ?? ''
}

function unquote(text: string): string {
  const [, , body] = /^(["'`])(.*)\1$/s.exec(text) ?? []
  return body ?? text
}

/** Join a route prefix and a path into one path with a single leading slash. */
function joinPath(prefix: string, path: string): string {
  const parts = [prefix, path].map(part => part.replace(/^\/+|\/+$/g, '')).filter(part => part.length > 0)
  return `/${parts.join('/')}`
}

function argName(arg: HardCpgArg): string {
  if ('lit' in arg) return unquote(arg.lit)
  if ('ref' in arg) return arg.ref
  if ('arr' in arg) return `[${arg.arr.join(', ')}]`
  return arg.code
}
