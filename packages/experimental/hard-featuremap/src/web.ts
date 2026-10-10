/**
 * The Host routes the browser feature map panel reads: one recorded feature's
 * symbol graph, and one symbol's call edges and source at the pinned commit.
 * They answer only for a session with a live agent, and register only where a
 * Web connection exists.
 * @module @deepseek-ai/dsh-experimental-hard-featuremap/web
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { FEATURE_GRAPH_PATH, SYMBOL_DETAIL_PATH } from './routes.ts'
import type { HardFeatureGraphView, HardSymbolDetail } from './types.ts'


/** What the routes read from the feature map service. */
export interface HardFeatureMapWebAccess {
  /** The live agent of a session, or undefined when none runs. */
  agent(session: string): Agent | undefined
  featureGraph(agent: Agent, featureId: string): Promise<HardFeatureGraphView | undefined>
  symbolDetail(agent: Agent, symbol: string): Promise<HardSymbolDetail | undefined>
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
}

/** One GET route reading two query parameters and answering for a live agent. */
function route(
  path: string,
  key: string,
  read: (agent: Agent, value: string) => Promise<object | undefined>,
  access: HardFeatureMapWebAccess,
): ConnectionFetchRoute {
  return {
    path,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const params = new URL(request.url).searchParams
      const session = params.get('session')
      const value = params.get(key)
      if (session === null || session === '' || value === null || value === '') return json({ error: `session and ${key} are required` }, 400)
      const agent = access.agent(session)
      if (agent === undefined) return json({ error: `session ${session} has no live agent` }, 404)
      try {
        const result = await read(agent, value)
        return result === undefined ? json({ error: `no ${key} ${value}` }, 404) : json(result)
      } catch (error: unknown) {
        return json({ error: String(error) }, 409)
      }
    },
  }
}

/**
 * The panel's routes over one service.
 * @param access - the feature map reads.
 * @returns the feature graph and symbol detail routes.
 */
export function featureMapRoutes(access: HardFeatureMapWebAccess): ConnectionFetchRoute[] {
  return [
    route(FEATURE_GRAPH_PATH, 'feature', (agent, value) => access.featureGraph(agent, value), access),
    route(SYMBOL_DETAIL_PATH, 'symbol', (agent, value) => access.symbolDetail(agent, value), access),
  ]
}
