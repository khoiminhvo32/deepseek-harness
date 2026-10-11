/**
 * The model-facing feature map tools: `hard_query_map` reads the map,
 * `hard_record_feature` records a feature the harness checked against it,
 * `hard_link_feature` records how two features relate, `hard_declare_guard`
 * and `hard_declare_entry_point` teach the map the target's own access
 * checks and routes, `hard_resolve_pair` closes a guard pair, and
 * `hard_review_feature` records an abuse review. The section text teaches
 * the mapping and abuse tasks.
 * @module @deepseek-ai/dsh-experimental-hard-featuremap/tools
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { HardLedger } from '@deepseek-ai/dsh-experimental-hard-ledger'
import { checkFeature, requiredSet } from './check.ts'
import type { HardFeatureGraph, HardFeaturePolicy } from './check.ts'
import type { HardEdgeRow, HardSymbolRow } from './types.ts'
import type { HardEntryPoint } from './wordpress.ts'

/** What the tools read from the feature map service. */
export interface HardFeatureMapAccess {
  /** The snapshot of the agent's pinned commit, imported on first use. */
  snapshotOf(agent: Agent): Promise<{ readonly id: number; readonly commit: string }>
  /** The graph queries of a snapshot, with the session's declared entry points. */
  graph(agent: Agent, snapshot: number): Promise<HardFeatureGraph>
  /** The indexed entry points followed by the session's declared ones. */
  entryPoints(agent: Agent, snapshot: number): Promise<HardEntryPoint[]>
  findSymbols(snapshot: number, text: string, limit: number): Promise<HardSymbolRow[]>
  symbol(snapshot: number, id: string): Promise<HardSymbolRow | undefined>
  callers(snapshot: number, symbol: string): Promise<HardEdgeRow[]>
  callees(snapshot: number, symbol: string): Promise<HardEdgeRow[]>
  /** Symbols that look like access checks and are not known guards yet. */
  guardCandidates(agent: Agent, snapshot: number): Promise<{ symbol: string; file: string; line: number | null; reasons: ('name' | 'denies')[] }[]>
  /** Derive and record the guard pairs among recorded features; returns the new pair ids. */
  derivePairs(agent: Agent): Promise<string[]>
  /** One line of a file at the agent's pinned commit, undefined when it does not exist. */
  lineText(agent: Agent, file: string, line: number): Promise<string | undefined>
  /** The check policy of the session: configured plus declared guards. */
  policyOf(agent: Agent): HardFeaturePolicy
}

/**
 * What a cited line must contain to stand as the place a declared guard
 * denies: an exception, an abort or exit, a 401 or 403 status, or an
 * access-denial message. A bare `return false` is not enough, because a
 * validation helper returns false too.
 */
export const HARD_DENY_EVIDENCE = new RegExp([
  '\\b(throw|abort|abort_if|abort_unless|exit|die|wp_die|raise|halt)\\b',
  '\\b40[13]\\b',
  'forbidden|unauthori[sz]ed|access denied|permission denied|not allowed',
].join('|'), 'i')

/** The system-prompt section that teaches the mapping task. */
export const FEATURE_MAP_SECTION = 'Feature map. The harness builds a map of the target from its call graph: entry points a request reaches, '
  + 'the symbols behind them, and the guards and state writes they reach. Map every feature, and map while you sweep: record each feature '
  + 'as soon as you have read the code behind its entry points instead of leaving the map for the end. See what is mapped with hard_query_map '
  + 'view features. List entry points with hard_query_map '
  + '(view entry-points, unmapped_only true), find symbol ids with view symbol, and see what a feature must account for with view required '
  + 'and its entry points. Record each feature with hard_record_feature: a name, what it does and for whom, its entry points, its symbols '
  + 'with roles (entry, guard, mutation, helper), the required symbols it leaves out with a reason (utility, other-feature, unreachable), '
  + 'and the state it reads or writes. The harness refuses a feature that leaves a required symbol unaccounted for, excludes a guard or a '
  + 'state write as utility, or names a symbol outside the reach without citing the call that reaches it (via). Link related features with '
  + 'hard_link_feature. Two features that write the same state behind different guards are where feature abuse hides: link them with '
  + 'kind shares-state and test the weaker path.\n\n'
  + 'Abuse. Each time you record a feature the harness compares the guards of entry points that write the same state: one that lacks a '
  + 'guard category (csrf, authentication, authorization) most of the others carry becomes a guard pair, and the harness links the two '
  + 'features as shares-state. Close every pair (hard_query_map view pairs) with hard_resolve_pair: a finding or hypothesis that tests the '
  + 'weaker path, or safe with the line of the check that covers it. When the target checks access in its own code, declare each such '
  + 'guard with hard_declare_guard and the line where it denies; view guards suggests candidates. Declare entry points no framework profile '
  + 'finds, such as a hand-written router, with hard_declare_entry_point and the dispatch line. Once features cover the required share, '
  + 'review every feature with hard_review_feature and ask what if for each lens: skip-step (skip a step of the intended flow), '
  + 'wrong-actor (a lower role or no login), wrong-object (someone else\'s object), sequence (steps out of order), race-replay (repeat or '
  + 'race a request), input (unexpected types, empty, arrays, extremes), shared-state (the same result through a weaker feature), limits '
  + '(exceed a count, go negative, overflow). Record where each question led: a finding, a hypothesis, a weakness (it becomes chain '
  + 'material), refuted, or not-applicable. Review every pair of linked features together as well: what does using them together allow '
  + 'that neither allows alone? Chain what the reviews find with the weaknesses you already hold.'

const DEFAULT_PAGE = 50
const MAX_PAGE = 200

/** One page of a list, with the total it was cut from. */
function page<T>(
  items: readonly T[],
  offset: number | undefined,
  limit: number | undefined,
): { total: number; offset: number; items: T[] } {
  const start = Math.max(0, offset ?? 0)
  const size = Math.min(MAX_PAGE, Math.max(1, limit ?? DEFAULT_PAGE))
  return { total: items.length, offset: start, items: items.slice(start, start + size) }
}

function present(title: string, rawInput: unknown): GenericCallView {
  return { card: 'generic', title, kind: 'other', rawInput }
}

function renderJson(_args: unknown, value: unknown): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

function liveAgent(agent: Agent | undefined, tool: string): Agent {
  if (agent === undefined) throw new Error(`${tool} requires a live agent`)
  return agent
}

/**
 * The three feature map tools over one service and ledger.
 * @param access - the feature map reads.
 * @param ledger - the ledger that records features and links.
 * @returns the tool definitions to register.
 */
export function featureMapTools(access: HardFeatureMapAccess, ledger: HardLedger): ToolDefinition[] {
  const query = defineTool({
    name: 'hard_query_map',
    description: 'Read the feature map of the pinned commit. view features lists the recorded features with their entry points, '
      + 'member counts, state, and whether each has an abuse review, the recorded links, and how many entry points features cover; '
      + 'view pairs lists the guard pairs with how each was closed; view guards lists the known and declared guards and suggests '
      + 'candidates (symbols named like access checks or denying with 401/403); view entry-points lists entry points '
      + '(kind:key, handler, routing guards, whether a feature covers it); view symbol finds symbol ids by name; view callers and callees '
      + 'list the call edges of one symbol with the rule that made each edge; view required computes what a feature with the given entry '
      + 'points must account for.',
    parameters: {
      view: { type: 'string', required: true, enum: ['features', 'pairs', 'guards', 'entry-points', 'symbol', 'callers', 'callees', 'required'], description: 'What to read.' },
      symbol: { type: 'string', description: 'The symbol id for callers and callees; the text to look for in view symbol.' },
      entry_points: { type: 'array', items: { type: 'string' }, description: 'Entry points as kind:key, for view required.' },
      kind: { type: 'string', description: 'Only entry points of this kind (ajax, admin-post, rest, shortcode, script, http).' },
      unmapped_only: { type: 'boolean', description: 'Only entry points no recorded feature covers.' },
      offset: { type: 'integer', description: 'Items to skip.' },
      limit: { type: 'integer', description: `Items to return, at most ${MAX_PAGE}.` },
    },
    output: { schema: { type: 'json' } as const, render: renderJson },
    async execute(args, exec) {
      const agent = liveAgent(exec.agent, 'hard_query_map')
      const snapshot = (await access.snapshotOf(agent)).id
      switch (args.view) {
        case 'features': {
          const features = ledger.features(agent)
          const covered = new Set(features.flatMap(feature => feature.entryPoints))
          const indexed = (await access.entryPoints(agent, snapshot)).map(entry => ({ key: `${entry.kind}:${entry.key}` }))
          const reviews = ledger.featureReviews(agent)
          const reviewed = new Set(reviews.filter(review => review.features.length === 1).flatMap(review => review.features))
          const items = features.map(feature => ({
            id: feature.id, name: feature.name, summary: feature.summary, entryPoints: [...feature.entryPoints],
            members: feature.symbols.length, excluded: feature.excluded.length, states: feature.states.map(entry => ({ ...entry })),
            reviewed: reviewed.has(feature.id),
          }))
          return {
            entryPoints: { mapped: indexed.filter(entry => covered.has(entry.key)).length, total: indexed.length },
            links: ledger.featureLinks(agent).map(link => ({ ...link })),
            ...page(items, args.offset, args.limit),
          }
        }
        case 'pairs': {
          const items = ledger.featurePairs(agent).map(pair => ({
            id: pair.id, category: pair.category, states: [...pair.states], weaker: { ...pair.weaker }, stronger: { ...pair.stronger },
            missing: [...pair.missing], resolved: pair.resolution?.outcome ?? null,
          }))
          return page(items, args.offset, args.limit)
        }
        case 'guards': {
          const policy = access.policyOf(agent)
          return {
            known: [...policy.guards].sort(),
            declared: ledger.declaredGuards(agent).map(guard => ({ symbol: guard.symbol, category: guard.category })),
            candidates: page(await access.guardCandidates(agent, snapshot), args.offset, args.limit),
          }
        }
        case 'entry-points': {
          const mapped = new Set(ledger.features(agent).flatMap(feature => feature.entryPoints))
          const items = (await access.entryPoints(agent, snapshot))
            .filter(entry => args.kind === undefined || entry.kind === args.kind)
            .map(entry => ({ key: `${entry.kind}:${entry.key}`, handler: entry.handler, auth: entry.auth, guards: [...entry.guards], mapped: mapped.has(`${entry.kind}:${entry.key}`) }))
            .filter(entry => args.unmapped_only !== true || !entry.mapped)
          return page(items, args.offset, args.limit)
        }
        case 'symbol':
          const symbols = await access.findSymbols(snapshot, requireText(args.symbol, 'symbol'), Math.min(MAX_PAGE, args.limit ?? DEFAULT_PAGE))
          return { items: symbols.map(row => ({ ...row })) }
        case 'callers':
        case 'callees': {
          const symbol = requireText(args.symbol, 'symbol')
          const edges = args.view === 'callers' ? await access.callers(snapshot, symbol) : await access.callees(snapshot, symbol)
          return { symbol, ...page(edges.map(edge => ({ ...edge })), args.offset, args.limit) }
        }
        case 'required': {
          const graph = await access.graph(agent, snapshot)
          const handlers = (args.entry_points ?? []).map((key) => {
            const handler = graph.entryPoint(key)?.handler
            if (handler === undefined || handler === null) throw new Error(`entry point ${key} is not in the feature map or has no resolved handler`)
            return handler
          })
          if (handlers.length === 0) throw new Error('view required needs entry_points')
          const set = requiredSet(graph, handlers, access.policyOf(agent))
          const required = [...set.required].map(([symbol, reasons]) => ({ symbol, reasons: [...reasons] }))
          return { handlers, reach: set.reach.size, library: set.library.size, ...page(required, args.offset, args.limit) }
        }
      }
    },
    presentCall: args => present(`Feature map: ${args.view}`, args),
  })

  const record = defineTool({
    name: 'hard_record_feature',
    description: 'Record one feature of the target after the harness checks it against the feature map. Name an existing feature_id to revise it. '
      + 'Every required symbol (view required) must be a member or an exclusion with a reason; guards and state writes cannot be excluded as utility; '
      + 'a member outside the reach of the handlers needs via with the reached caller and the line of the call.',
    parameters: {
      feature_id: { type: 'string', description: 'An existing FE-n id to revise.' },
      name: { type: 'string', required: true, description: 'One-line feature name.' },
      summary: { type: 'string', required: true, description: 'What the feature does and for whom.' },
      entry_points: { type: 'array', required: true, items: { type: 'string' }, description: 'Entry points as kind:key from view entry-points.' },
      symbols: {
        type: 'array', required: true, description: 'Member symbols with their role.',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            symbol: { type: 'string', required: true },
            role: { type: 'string', required: true, enum: ['entry', 'guard', 'mutation', 'helper'] },
          },
        },
      },
      excluded: {
        type: 'array', description: 'Required symbols left out of the feature, with the reason.',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            symbol: { type: 'string', required: true },
            reason: { type: 'string', required: true, enum: ['utility', 'other-feature', 'unreachable'] },
            note: { type: 'string' },
          },
        },
      },
      via: {
        type: 'array', description: 'For members outside the reach: the reached caller and the line of the call in its file.',
        items: {
          type: 'object', additionalProperties: false,
          properties: { symbol: { type: 'string', required: true }, caller: { type: 'string', required: true }, line: { type: 'integer', required: true } },
        },
      },
      states: {
        type: 'array', description: 'State the feature reads or writes.',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            kind: { type: 'string', required: true, description: 'table, option, meta, file, cache, session, or similar.' },
            key: { type: 'string', required: true },
            access: { type: 'string', required: true, enum: ['read', 'write'] },
          },
        },
      },
    },
    output: { schema: { type: 'json' } as const, render: renderJson },
    async execute(args, exec) {
      const agent = liveAgent(exec.agent, 'hard_record_feature')
      const { id: snapshot, commit } = await access.snapshotOf(agent)
      const graph = await access.graph(agent, snapshot)
      const excluded = (args.excluded ?? []).map(entry => ({
        symbol: entry.symbol,
        reason: entry.reason,
        ...entry.note === undefined ? {} : { note: entry.note },
      }))
      const check = await checkFeature(graph, {
        entryPoints: args.entry_points,
        symbols: args.symbols,
        excluded,
        via: args.via ?? [],
      }, access.policyOf(agent), (file, line) => access.lineText(agent, file, line))
      if (check.shortfalls.length > 0) {
        throw new HarnessError(`hard_record_feature refused — ${check.shortfalls.join('; ')}`, 'HARD_FEATUREMAP_FEATURE_REFUSED')
      }
      const id = ledger.recordFeature(agent, {
        ...args.feature_id === undefined ? {} : { id: args.feature_id.trim() },
        name: args.name,
        summary: args.summary,
        entryPoints: args.entry_points,
        symbols: args.symbols,
        excluded,
        states: args.states ?? [],
        check: { commit, reach: check.reach, required: check.required },
      })
      const unmappedEntryPoints = ledger.unmappedEntryPoints(agent).length
      const pairs = await access.derivePairs(agent)
      return { feature: { id }, check: { reach: check.reach, required: check.required }, unmappedEntryPoints, pairs }
    },
    presentCall: args => present(`Feature: ${args.name}`, args.entry_points.join(', ')),
  })

  const link = defineTool({
    name: 'hard_link_feature',
    description: 'Record how two recorded features relate: calls, shares-state (both read or write the same state), gates (one checks access for the other), or enables (one sets up state the other needs).',
    parameters: {
      from: { type: 'string', required: true, description: 'The FE-n feature the relation starts at.' },
      to: { type: 'string', required: true, description: 'The FE-n feature the relation ends at.' },
      kind: { type: 'string', required: true, enum: ['calls', 'shares-state', 'gates', 'enables'], description: 'The relation.' },
      note: { type: 'string', required: true, description: 'What connects them, such as the shared state and each side\'s guard.' },
    },
    output: { schema: { type: 'json' } as const, render: renderJson },
    execute(args, exec) {
      const agent = liveAgent(exec.agent, 'hard_link_feature')
      ledger.linkFeature(agent, { from: args.from.trim(), to: args.to.trim(), kind: args.kind, note: args.note })
      return Promise.resolve({ linked: { from: args.from.trim(), to: args.to.trim(), kind: args.kind } })
    },
    presentCall: args => present(`Feature link: ${args.from} ${args.kind} ${args.to}`, args.note),
  })

  const lineAt = async (agent: Agent, file: string, line: number, tool: string): Promise<string> => {
    const text = await access.lineText(agent, file, line)
    if (text === undefined) throw new HarnessError(`${tool} refused — ${file}:${line} does not exist at the pinned commit`, 'HARD_FEATUREMAP_CITE_MISSING')
    return text
  }

  const declareGuard = defineTool({
    name: 'hard_declare_guard',
    description: 'Declare an access check the target wrote itself, so the feature check and the guard pairs count it. Cite the line in its '
      + 'body where it denies: an exception, an abort or exit, a 401 or 403 status, or an access-denial message; a bare return false is not enough.',
    parameters: {
      symbol: { type: 'string', required: true, description: 'The guard symbol id (view symbol).' },
      category: { type: 'string', required: true, enum: ['csrf', 'authentication', 'authorization'], description: 'What it checks: request forgery, who the caller is, or what the caller may do.' },
      file: { type: 'string', required: true, description: 'The file of the denying line, target-repo relative.' },
      line: { type: 'integer', required: true, description: 'The denying line.' },
      note: { type: 'string', required: true, description: 'What the guard checks.' },
    },
    output: { schema: { type: 'json' } as const, render: renderJson },
    async execute(args, exec) {
      const agent = liveAgent(exec.agent, 'hard_declare_guard')
      const { id: snapshot } = await access.snapshotOf(agent)
      const row = await access.symbol(snapshot, args.symbol)
      if (row === undefined) throw new HarnessError(`hard_declare_guard refused — ${args.symbol} is not in the feature map`, 'HARD_FEATUREMAP_UNKNOWN_SYMBOL')
      const inside = row.file === args.file && (row.line === null || (args.line >= row.line && args.line <= (row.end ?? row.line)))
      if (!inside) throw new HarnessError(`hard_declare_guard refused — ${args.file}:${args.line} is not inside ${args.symbol} (${row.file}:${row.line ?? '?'})`, 'HARD_FEATUREMAP_GUARD_REFUSED')
      const text = await lineAt(agent, args.file, args.line, 'hard_declare_guard')
      if (!HARD_DENY_EVIDENCE.test(text)) {
        throw new HarnessError(`hard_declare_guard refused — ${args.file}:${args.line} shows no denial (exception, abort, exit, 401/403, or a denial message)`, 'HARD_FEATUREMAP_GUARD_REFUSED')
      }
      const cite = { file: args.file, line: args.line }
      ledger.declareGuard(agent, { symbol: args.symbol, category: args.category, cite, note: args.note })
      return { declared: { symbol: args.symbol, category: args.category }, pairs: await access.derivePairs(agent) }
    },
    presentCall: args => present(`Guard: ${args.symbol}`, `${args.category} ${args.file}:${args.line}`),
  })

  const declareEntry = defineTool({
    name: 'hard_declare_entry_point',
    description: 'Declare an entry point no framework profile finds, such as a case of a hand-written router, so features can cover it. '
      + 'Cite the dispatch line that reaches the handler; it must name the handler.',
    parameters: {
      name: { type: 'string', required: true, description: 'A short name; the entry point becomes custom:<name>.' },
      handler: { type: 'string', required: true, description: 'The handler symbol id (view symbol).' },
      auth: { type: 'string', required: true, enum: ['public', 'authenticated', 'unknown'], description: 'Who can reach it as routed.' },
      file: { type: 'string', required: true, description: 'The file of the dispatch line, target-repo relative.' },
      line: { type: 'integer', required: true, description: 'The dispatch line.' },
    },
    output: { schema: { type: 'json' } as const, render: renderJson },
    async execute(args, exec) {
      const agent = liveAgent(exec.agent, 'hard_declare_entry_point')
      const { id: snapshot } = await access.snapshotOf(agent)
      const row = await access.symbol(snapshot, args.handler)
      if (row === undefined) throw new HarnessError(`hard_declare_entry_point refused — ${args.handler} is not in the feature map`, 'HARD_FEATUREMAP_UNKNOWN_SYMBOL')
      const text = await lineAt(agent, args.file, args.line, 'hard_declare_entry_point')
      if (!text.includes(row.name)) {
        throw new HarnessError(`hard_declare_entry_point refused — ${args.file}:${args.line} does not name ${row.name}`, 'HARD_FEATUREMAP_ENTRY_REFUSED')
      }
      const key = `custom:${requireText(args.name, 'name')}`
      ledger.declareEntryPoint(agent, { key, handler: args.handler, auth: args.auth, cite: { file: args.file, line: args.line } })
      return { declared: { key, handler: args.handler } }
    },
    presentCall: args => present(`Entry point: custom:${args.name}`, `${args.file}:${args.line}`),
  })

  const resolvePair = defineTool({
    name: 'hard_resolve_pair',
    description: 'Close one guard pair. finding or hypothesis names the F-n or H-n that proves or tests the weaker path; safe cites the line '
      + 'of the check that covers the weaker path, which must name a known guard or show a denial.',
    parameters: {
      pair_id: { type: 'string', required: true, description: 'The P-n pair id.' },
      outcome: { type: 'string', required: true, enum: ['finding', 'hypothesis', 'safe'] },
      ref: { type: 'string', description: 'The F-n or H-n id for finding and hypothesis.' },
      file: { type: 'string', description: 'For safe: the file of the covering check, target-repo relative.' },
      line: { type: 'integer', description: 'For safe: the line of the covering check.' },
      reason: { type: 'string', required: true, description: 'Why the outcome holds.' },
    },
    output: { schema: { type: 'json' } as const, render: renderJson },
    async execute(args, exec) {
      const agent = liveAgent(exec.agent, 'hard_resolve_pair')
      if (args.outcome === 'safe') {
        if (args.file === undefined || args.line === undefined) {
          throw new HarnessError('hard_resolve_pair refused — safe needs the file and line of the covering check', 'HARD_FEATUREMAP_PAIR_REFUSED')
        }
        const text = await lineAt(agent, args.file, args.line, 'hard_resolve_pair')
        const guards = [...access.policyOf(agent).guards].map(guard => guard.slice(guard.lastIndexOf('.') + 1))
        if (!guards.some(guard => text.includes(guard)) && !HARD_DENY_EVIDENCE.test(text)) {
          throw new HarnessError(`hard_resolve_pair refused — ${args.file}:${args.line} names no known guard and shows no denial`, 'HARD_FEATUREMAP_PAIR_REFUSED')
        }
      }
      ledger.resolveFeaturePair(agent, {
        id: args.pair_id.trim(),
        outcome: args.outcome,
        ...args.ref === undefined ? {} : { ref: args.ref.trim() },
        ...args.file === undefined || args.line === undefined ? {} : { cite: { file: args.file, line: args.line } },
        reason: args.reason,
      })
      const unresolved = ledger.featurePairs(agent).filter(pair => pair.resolution === undefined).length
      return { resolved: { id: args.pair_id.trim(), outcome: args.outcome }, unresolved }
    },
    presentCall: args => present(`Guard pair ${args.pair_id}: ${args.outcome}`, args.reason),
  })

  const review = defineTool({
    name: 'hard_review_feature',
    description: 'Record an abuse review. With one feature, ask at least one what-if question for every lens; with two or more linked '
      + 'features, ask what using them together allows that neither allows alone. Each question records where it led: finding, '
      + 'hypothesis, or weakness with its F-n, H-n, or W-n id (a weakness becomes chain material), refuted, or not-applicable, with the reason.',
    parameters: {
      features: { type: 'array', required: true, items: { type: 'string' }, description: 'One FE-n id, or the FE-n ids used together.' },
      cases: {
        type: 'array', required: true, description: 'The what-if questions.',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            lens: { type: 'string', required: true, enum: ['skip-step', 'wrong-actor', 'wrong-object', 'sequence', 'race-replay', 'input', 'shared-state', 'limits'] },
            question: { type: 'string', required: true, description: 'The what-if question.' },
            outcome: { type: 'string', required: true, enum: ['finding', 'hypothesis', 'weakness', 'refuted', 'not-applicable'] },
            ref: { type: 'string', description: 'The F-n, H-n, or W-n id for finding, hypothesis, and weakness.' },
            reason: { type: 'string', required: true, description: 'What the code does that settles the question.' },
          },
        },
      },
    },
    output: { schema: { type: 'json' } as const, render: renderJson },
    execute(args, exec) {
      const agent = liveAgent(exec.agent, 'hard_review_feature')
      ledger.reviewFeatures(agent, {
        features: args.features.map(id => id.trim()),
        cases: args.cases.map(entry => ({ ...entry, ...entry.ref === undefined ? {} : { ref: entry.ref.trim() } })),
      })
      return Promise.resolve({ reviewed: [...new Set(args.features.map(id => id.trim()))].sort(), cases: args.cases.length })
    },
    presentCall: args => present(`Abuse review: ${args.features.join(' + ')}`, `${args.cases.length} questions`),
  })

  return [query, record, link, declareGuard, declareEntry, resolvePair, review]
}

function requireText(value: string | undefined, field: string): string {
  const text = value?.trim() ?? ''
  if (text.length === 0) throw new Error(`${field} is required for this view`)
  return text
}
