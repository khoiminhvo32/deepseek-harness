/** Slot props for the hard panels over a Session store whose `hardLedger` projection the test can replace. */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { HardLedgerClientView } from '@deepseek-ai/dsh-experimental-hard-ledger/client'
import type { SessionListState, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { CoverageMatrixProps } from '../src/client/CoverageMatrix.tsx'
import { zh } from '../src/client/locales.ts'

/** The Session every panel test reads. */
export const SESSION = 'hard-session' as SessionId

/** The panels never read tab chrome; the props type still carries the seat hook. */
const unusedTabInfo = (): never => {
  throw new Error('the hard panels do not read tab info')
}

/**
 * Props for one panel over a Session store holding the given projection.
 * @param projection - the projection state and the `hardLedger` view, undefined for none.
 * @returns the props and a setter that publishes a new view.
 */
export function panelProps(projection: { state: 'idle' | 'loading' | 'ready' | 'error'; view: HardLedgerClientView | undefined }): {
  props: CoverageMatrixProps
  publish: (view: HardLedgerClientView) => void
} {
  const values = (view: HardLedgerClientView | undefined) => view === undefined ? {} : { hardLedger: view }
  const sessions = createSnapshotStore<SessionListState>({
    ids: [SESSION],
    byId: { [SESSION]: { id: SESSION, displayTitle: SESSION, running: false, retainedBy: {}, blank: false, updatedAt: 0 } },
    phase: 'ready',
    projectionsBySession: { [SESSION]: { state: projection.state, error: null, values: values(projection.view) } },
  }, { flush: 'sync' })
  const session = createSnapshotStore<SessionSnapshot>({
    sessionId: SESSION,
    pendingSubmissions: [],
    running: false,
    subagent: null,
    removed: false,
    openState: 'open',
    openError: null,
    hasMore: false,
    loadingOlder: false,
    promptError: null,
    blank: false,
    lastAgentError: null,
    promptAttempted: false,
    awaitingFirstTurn: false,
  })
  const props = {
    sessionId: SESSION,
    useSession: bindSnapshotSelector(session),
    useSessions: bindSnapshotSelector(sessions),
    useProjection: (key: string) => key === 'hardLedger' ? sessions.getSnapshot().projectionsBySession[SESSION]?.values.hardLedger : undefined,
    useTabInfo: unusedTabInfo,
    t: makeTranslate(zh, commonZh),
  } as CoverageMatrixProps
  const publish = (view: HardLedgerClientView) => {
    sessions.set({ ...sessions.getSnapshot(), projectionsBySession: { [SESSION]: { state: 'ready', error: null, values: values(view) } } })
  }
  return { props, publish }
}
