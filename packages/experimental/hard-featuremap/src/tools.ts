/**
 * The model-facing feature map tools: `hard_query_map` reads the map,
 * `hard_record_feature` records a feature the harness checked against it,
 * and `hard_link_feature` records how two features relate. The section text
 * teaches the mapping task.
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
  graph(snapshot: number): Promise<HardFeatureGraph>
  entryPoints(snapshot: number): Promise<HardEntryPoint[]>
  findSymbols(snapshot: number, text: string, limit: number): Promise<HardSymbolRow[]>
  callers(snapshot: number, symbol: string): Promise<HardEdgeRow[]>
  callees(snapshot: number, symbol: string): Promise<HardEdgeRow[]>
  /** One line of a file at the agent's pinned commit, undefined when it does not exist. */
  lineText(agent: Agent, file: string, line: number): Promise<string | undefined>
  readonly policy: HardFeaturePolicy
}

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
  + 'kind shares-state and test the weaker path.'

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
      + 'member counts, and state, the recorded links, and how many entry points features cover; view entry-points lists entry points '
      + '(kind:key, handler, routing guards, whether a feature covers it); view symbol finds symbol ids by name; view callers and callees '
      + 'list the call edges of one symbol with the rule that made each edge; view required computes what a feature with the given entry '
      + 'points must account for.',
    parameters: {
      view: { type: 'string', required: true, enum: ['features', 'entry-points', 'symbol', 'callers', 'callees', 'required'], description: 'What to read.' },
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
          const indexed = (await access.entryPoints(snapshot)).map(entry => ({ key: `${entry.kind}:${entry.key}` }))
          const items = features.map(feature => ({
            id: feature.id, name: feature.name, summary: feature.summary, entryPoints: [...feature.entryPoints],
            members: feature.symbols.length, excluded: feature.excluded.length, states: feature.states.map(entry => ({ ...entry })),
          }))
          return {
            entryPoints: { mapped: indexed.filter(entry => covered.has(entry.key)).length, total: indexed.length },
            links: ledger.featureLinks(agent).map(link => ({ ...link })),
            ...page(items, args.offset, args.limit),
          }
        }
        case 'entry-points': {
          const mapped = new Set(ledger.features(agent).flatMap(feature => feature.entryPoints))
          const items = (await access.entryPoints(snapshot))
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
          const graph = await access.graph(snapshot)
          const handlers = (args.entry_points ?? []).map((key) => {
            const handler = graph.entryPoint(key)?.handler
            if (handler === undefined || handler === null) throw new Error(`entry point ${key} is not in the feature map or has no resolved handler`)
            return handler
          })
          if (handlers.length === 0) throw new Error('view required needs entry_points')
          const set = requiredSet(graph, handlers, access.policy)
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
      const graph = await access.graph(snapshot)
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
      }, access.policy, (file, line) => access.lineText(agent, file, line))
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
      return { feature: { id }, check: { reach: check.reach, required: check.required }, unmappedEntryPoints }
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

  return [query, record, link]
}

function requireText(value: string | undefined, field: string): string {
  const text = value?.trim() ?? ''
  if (text.length === 0) throw new Error(`${field} is required for this view`)
  return text
}
