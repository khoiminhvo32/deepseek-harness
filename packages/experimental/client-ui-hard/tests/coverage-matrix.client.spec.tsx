// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { HardLedgerClientView } from '@deepseek-ai/dsh-experimental-hard-ledger/client'
import type { SessionListState, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { CoverageMatrix, type CoverageMatrixProps } from '../src/client/CoverageMatrix.tsx'
// The locale-namespace merge for `hard` lives beside the registrations.
import type {} from '../src/client/mount.ts'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
})

const SESSION = 'hard-session' as SessionId

const MATRIX = {
  modules: ['data/manuals', 'src'],
  bugClasses: ['cmdi', 'sqli'],
  inertModules: ['data/manuals'],
  targetRepo: '/tmp/pilot-target',
  commit: 'a'.repeat(40),
}

/** The panel never reads tab chrome; the props type still carries the seat hook. */
const unusedTabInfo = (): never => {
  throw new Error('CoverageMatrix does not read tab info')
}

/** One folded wire view with the given cells and gate, over the armed 2×2 matrix. */
function view(overrides: {
  cells?: HardLedgerClientView['cells']
  progress?: HardLedgerClientView['progress']
  gate?: HardLedgerClientView['gate']
  /** `'none'` renders the no-arming-record empty state. */
  matrix?: 'none' | HardLedgerClientView['matrix']
} = {}): HardLedgerClientView {
  const matrix = overrides.matrix === undefined ? MATRIX : overrides.matrix === 'none' ? undefined : overrides.matrix
  return {
    ...(matrix === undefined ? {} : { matrix }),
    cells: overrides.cells ?? [
      { module: 'src', bugClass: 'cmdi', verdict: 'cleared', source: 'model' },
      { module: 'src', bugClass: 'sqli', verdict: 'suspicious', source: 'harness' },
    ],
    progress: overrides.progress ?? { verdicted: 4, total: 4 },
    bySource: overrides.cells === undefined ? { model: 1, modelVerified: 0, harness: 3 } : { model: 0, modelVerified: 0, harness: 0 },
    gate: overrides.gate ?? { complete: true, blockers: [] },
  }
}

function bench(projection: { state: 'idle' | 'loading' | 'ready' | 'error'; view: HardLedgerClientView | undefined } = { state: 'ready', view: undefined }): CoverageMatrixProps {
  const sessions = createSnapshotStore<SessionListState>({
    ids: [SESSION],
    byId: { [SESSION]: { id: SESSION, displayTitle: SESSION, running: false, retainedBy: {}, blank: false, updatedAt: 0 } },
    phase: 'ready',
    projectionsBySession: {
      [SESSION]: { state: projection.state, error: null, values: projection.view === undefined ? {} : { hardLedger: projection.view } },
    },
  })
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
  return {
    sessionId: SESSION,
    useSession: bindSnapshotSelector(session),
    useSessions: bindSnapshotSelector(sessions),
    useProjection: (key: string) => key === 'hardLedger' ? projection.view : undefined,
    useTabInfo: unusedTabInfo,
    t: makeTranslate(zh, commonZh),
  } as CoverageMatrixProps
}

describe('CoverageMatrix', () => {
  it('renders the armed matrix with per-face cells, progress, target, and a certified gate', () => {
    const { container } = render(<CoverageMatrix {...bench({ state: 'ready', view: view() })} />)
    const root = container.querySelector('[data-hard-coverage]')
    expect(root).not.toBeNull()
    // The two model/harness event cells and the two inert-screen cells are
    // distinguishable faces, not one "cleared" color.
    expect(root?.querySelector('[data-hard-cell="model"]')).not.toBeNull()
    expect(root?.querySelector('[data-hard-cell="suspicious-harness"]')).not.toBeNull()
    expect(root?.querySelectorAll('[data-hard-cell="harness"]')).toHaveLength(2)
    expect(root?.querySelector('[data-hard-progress]')?.textContent).toBe('4/4 已判定')
    expect(root?.querySelector('[data-hard-target]')?.textContent).toContain('pilot-target@aaaaaaa')
    expect(screen.getByText('完成门已认证').className).toContain('gateOk')
    // Module and class names are untranslated session data; the header labels come from the dictionary.
    expect(screen.getByText('data/manuals')).toBeTruthy()
    expect(screen.getByText('cmdi')).toBeTruthy()
    expect(screen.getByText('模块')).toBeTruthy()
  })

  it('distinguishes every decider face: model, batch-verified, harness, and both suspicious sides', () => {
    const { container } = render(<CoverageMatrix {...bench({ state: 'ready', view: view({
      cells: [
        { module: 'src', bugClass: 'cmdi', verdict: 'cleared', source: 'model' },
        { module: 'src', bugClass: 'sqli', verdict: 'cleared', source: 'model-verified' },
      ],
    }) })} />)
    const root = container.querySelector('[data-hard-coverage]')
    expect(root?.querySelector('[data-hard-cell="model"]')).not.toBeNull()
    expect(root?.querySelector('[data-hard-cell="model-verified"]')).not.toBeNull()
    expect(root?.querySelectorAll('[data-hard-cell="harness"]')).toHaveLength(2)
  })

  it('lists bounded gate blockers when the gate is open', () => {
    const { container } = render(<CoverageMatrix {...bench({ state: 'ready', view: view({
      gate: { complete: false, blockers: ['cell src × sqli is suspicious: re-verify the declared sinks', '1 of 2 final sweeps are empty-verified', 'third', 'fourth', 'fifth'] },
    }) })} />)
    const blockers = container.querySelector('[data-hard-blockers]')
    // Four bounded items plus the remainder marker.
    expect(blockers?.querySelectorAll('li')).toHaveLength(5)
    expect(blockers?.textContent).toContain('cell src × sqli is suspicious')
    expect(blockers?.textContent).toContain('…')
  })

  it('shows the loading notice while the projection baseline reads, then the empty one when idle', () => {
    const loading = render(<CoverageMatrix {...bench({ state: 'loading', view: undefined })} />)
    expect(loading.container.querySelector('[data-hard-coverage]')?.textContent).toContain('正在加载台账…')
    cleanup()
    const idle = render(<CoverageMatrix {...bench({ state: 'ready', view: undefined })} />)
    expect(idle.container.querySelector('[data-hard-coverage]')?.textContent).toContain('覆盖矩阵尚未武装')
  })

  it('shows the empty notice when the projection carries no arming record', () => {
    const { container } = render(<CoverageMatrix {...bench({ state: 'ready', view: view({ matrix: 'none' }) })} />)
    expect(container.querySelector('[data-hard-coverage]')?.textContent).toContain('覆盖矩阵尚未武装')
  })
})
