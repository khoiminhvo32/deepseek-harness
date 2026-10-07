/**
 * The hard-harness coverage panel: the armed matrix as a module × bug-class
 * grid, the coverage ratio, the target, and the completion gate's state. Each
 * cell shows two facts in its face — the verdict and who decided it — because
 * a machine-screened clear is a different claim from a model's own read.
 * Repository-scoped classes sweep the repo as a whole, so they render as one
 * strip cell instead of one per module.
 */
import type { ReactNode } from 'react'
// The `hardLedger` key on SessionProjectionMap arrives through this merge.
import type {} from '@deepseek-ai/dsh-experimental-hard-ledger/client'
import { StateDot, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
// The session standard kit (sessionId, useSession, useSessions, useProjection)
// arrives through these merges.
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { HardLedgerClientView } from '@deepseek-ai/dsh-experimental-hard-ledger/client'
import { NS, type HardKey } from './locales.ts'
import css from './CoverageMatrix.module.css'

/** Full props of the coverage panel, composed from the slot's shares. */
export type CoverageMatrixProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<typeof NS>

/** The visual face of one cell: verdict and decider together. */
type CellFace = 'model' | 'model-verified' | 'harness' | 'suspicious-harness' | 'suspicious-model' | 'uncovered'

/** All six faces, in legend order; the list keeps the legend exhaustive. */
const FACES: readonly CellFace[] = [
  'model', 'model-verified', 'harness', 'suspicious-harness', 'suspicious-model', 'uncovered',
]

/** Locale key of each cell face — the label names verdict and decider together. */
const FACE_LABEL: Record<CellFace, HardKey> = {
  model: 'face.model',
  'model-verified': 'face.modelVerified',
  harness: 'face.harness',
  'suspicious-harness': 'face.suspiciousHarness',
  'suspicious-model': 'face.suspiciousModel',
  uncovered: 'verdict.uncovered',
}

/** One grid cell: a colored square whose tooltip names the cell, verdict, and decider. */
function MatrixCell({ face, subject, label }: {
  face: CellFace
  /** Tooltip and aria subject: `module × class`, or the repository label. */
  subject: string
  label: string
}): ReactNode {
  return (
    <Tooltip label={`${subject} — ${label}`} side="top" delayMs={300}>
      <span className={`${css.cell} ${css[face]}`} data-hard-cell={face} role="img" aria-label={`${subject} ${label}`} />
    </Tooltip>
  )
}

/** The face of one event-backed cell, falling back to the inert screen or uncovered. */
function faceOf(cell: HardLedgerClientView['cells'][number] | undefined, inertModule: boolean): CellFace {
  if (cell === undefined) return inertModule ? 'harness' : 'uncovered'
  if (cell.verdict === 'suspicious') return cell.source === 'harness' ? 'suspicious-harness' : 'suspicious-model'
  if (cell.verdict !== 'cleared') return 'uncovered'
  if (cell.source === 'harness') return 'harness'
  if (cell.source === 'model-verified') return 'model-verified'
  return 'model'
}

/** Render the coverage panel from the session's `hardLedger` projection value. */
export function CoverageMatrix({ sessionId, useSessions, t }: CoverageMatrixProps): ReactNode {
  const view = useSessions(state => state.projectionsBySession[sessionId]?.values.hardLedger)
  const projectionState = useSessions(state => state.projectionsBySession[sessionId]?.state)

  if (view === undefined) {
    const loading = projectionState === 'idle' || projectionState === 'loading'
    return (
      <div className={css.root} data-hard-coverage>
        <div className={css.notice} role="status">
          <StateDot state={loading ? 'ongoing' : 'warning'} />
          {t(loading ? 'loading' : 'empty')}
        </div>
      </div>
    )
  }

  const matrix = view.matrix
  if (matrix === undefined) {
    return (
      <div className={css.root} data-hard-coverage>
        <div className={css.notice} role="status">
          <StateDot state="warning" />
          {t('empty')}
        </div>
      </div>
    )
  }

  const byCell = new Map(view.cells.map(cell => [`${cell.module}\u0000${cell.bugClass}`, cell]))
  const inert = new Set(matrix.inertModules ?? [])
  // Repository-scoped classes sweep the repo as a whole; the grid stays module-scoped.
  const scopeOf = (bugClass: string): 'module' | 'repo' => matrix.classScopes[bugClass] ?? 'module'
  const moduleClasses = matrix.bugClasses.filter(bugClass => scopeOf(bugClass) === 'module')
  const repoClasses = matrix.bugClasses.filter(bugClass => scopeOf(bugClass) === 'repo')
  const byRepoClass = new Map(view.cells.map(cell => [cell.bugClass, cell]))

  return (
    <div className={css.root} data-hard-coverage>
      <header className={css.header}>
        <span className={css.progress} data-hard-progress>
          {view.progress.verdicted}/{view.progress.total} {t('progress')}
        </span>
        <span className={css.target} data-hard-target title={matrix.targetRepo}>
          {t('target')}: {matrix.targetRepo.split('/').at(-1)}@{matrix.commit.slice(0, 7)}
        </span>
        <span className={`${css.gate} ${view.gate.complete ? css.gateOk : css.gateBlocked}`} data-hard-gate>
          <StateDot state={view.gate.complete ? 'done' : 'ongoing'} />
          {t(view.gate.complete ? 'gate.certified' : 'gate.blocked')}
        </span>
      </header>
      {!view.gate.complete && view.gate.blockers.length > 0 && (
        <ul className={css.blockers} data-hard-blockers role="list">
          {view.gate.blockers.slice(0, 4).map(blocker => <li key={blocker}>{blocker}</li>)}
          {view.gate.blockers.length > 4 && <li>…</li>}
        </ul>
      )}
      <div className={css.scroll} role="region" aria-label={t('tab.title')}>
        <table className={css.grid}>
          <thead>
            <tr>
              <th scope="col" className={css.moduleHead}>{t('column.module')}</th>
              {moduleClasses.map(bugClass => <th key={bugClass} scope="col" className={css.classHead}>{bugClass}</th>)}
            </tr>
          </thead>
          <tbody>
            {matrix.modules.map(module => (
              <tr key={module}>
                <th scope="row" className={css.moduleCell}>{module}</th>
                {moduleClasses.map((bugClass) => {
                  const face = faceOf(byCell.get(`${module}\u0000${bugClass}`), inert.has(module))
                  return (
                    <td key={bugClass} className={css.cellSlot}>
                      <MatrixCell face={face} subject={`${module} × ${bugClass}`} label={t(FACE_LABEL[face])} />
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {repoClasses.length > 0 && (
          <div className={css.repoRow} data-hard-repo-row role="list" aria-label={t('scope.repo')}>
            <span className={css.repoLabel}>{t('scope.repo')}</span>
            {repoClasses.map((bugClass) => {
              const face = faceOf(byRepoClass.get(bugClass), false)
              return (
                <span key={bugClass} className={css.repoCell} role="listitem">
                  <MatrixCell face={face} subject={`${t('scope.repo')} × ${bugClass}`} label={t(FACE_LABEL[face])} />
                  {bugClass}
                </span>
              )
            })}
          </div>
        )}
      </div>
      <footer className={css.legend} data-hard-legend>
        {FACES.map(face => (
          <span key={face} className={css.legendItem}>
            <span className={`${css.cell} ${css[face]}`} aria-hidden="true" /> {t(FACE_LABEL[face])}
          </span>
        ))}
      </footer>
    </div>
  )
}
