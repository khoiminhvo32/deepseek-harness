/**
 * The hard-harness coverage panel: the armed matrix as a module × bug-class
 * grid, the coverage ratio, the target, and the completion gate's state. Each
 * cell shows two facts in its face — the verdict and who decided it — because
 * a machine-screened clear is a different claim from a model's own read.
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
import { NS, type HardKey } from './locales.ts'
import css from './CoverageMatrix.module.css'

/** Full props of the coverage panel, composed from the slot's shares. */
export type CoverageMatrixProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<typeof NS>

/** The visual face of one cell: verdict and decider together. */
type CellFace = 'model' | 'model-verified' | 'harness' | 'suspicious-harness' | 'suspicious-model' | 'uncovered'

/** Locale key of each cell face, for the tooltip and the legend. */
const FACE_LABEL: Record<CellFace, HardKey> = {
  model: 'verdict.cleared',
  'model-verified': 'source.modelVerified',
  harness: 'source.harness',
  'suspicious-harness': 'verdict.suspicious',
  'suspicious-model': 'verdict.suspicious',
  uncovered: 'verdict.uncovered',
}

/** One grid cell: a colored square whose tooltip names the cell, verdict, and decider. */
function MatrixCell({ face, module, bugClass, label, detail }: {
  face: CellFace
  module: string
  bugClass: string
  label: string
  detail: string
}): ReactNode {
  return (
    <Tooltip label={`${module} × ${bugClass} — ${label}${detail === '' ? '' : ` (${detail})`}`} side="top" delayMs={300}>
      <span className={`${css.cell} ${css[face]}`} data-hard-cell={face} role="img" aria-label={`${module} ${bugClass} ${label}`} />
    </Tooltip>
  )
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
  const faceOf = (module: string, bugClass: string): CellFace => {
    const cell = byCell.get(`${module}\u0000${bugClass}`)
    if (cell === undefined) return inert.has(module) ? 'harness' : 'uncovered'
    if (cell.verdict === 'suspicious') return cell.source === 'harness' ? 'suspicious-harness' : 'suspicious-model'
    if (cell.verdict !== 'cleared') return 'uncovered'
    if (cell.source === 'harness') return 'harness'
    if (cell.source === 'model-verified') return 'model-verified'
    return 'model'
  }
  // Faces whose label names only one axis carry the other axis as the tooltip detail.
  const faceDetail = (face: CellFace): string => {
    if (face === 'model') return t('source.model')
    if (face === 'suspicious-harness') return t('source.harness')
    if (face === 'suspicious-model') return t('source.model')
    return ''
  }

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
              {matrix.bugClasses.map(bugClass => <th key={bugClass} scope="col" className={css.classHead}>{bugClass}</th>)}
            </tr>
          </thead>
          <tbody>
            {matrix.modules.map(module => (
              <tr key={module}>
                <th scope="row" className={css.moduleCell}>{module}</th>
                {matrix.bugClasses.map((bugClass) => {
                  const face = faceOf(module, bugClass)
                  return (
                    <td key={bugClass} className={css.cellSlot}>
                      <MatrixCell face={face} module={module} bugClass={bugClass} label={t(FACE_LABEL[face])} detail={faceDetail(face)} />
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <footer className={css.legend} data-hard-legend>
        <span className={`${css.cell} ${css.model}`} aria-hidden="true" /> {t('source.model')}
        <span className={`${css.cell} ${css['model-verified']}`} aria-hidden="true" /> {t('source.modelVerified')}
        <span className={`${css.cell} ${css.harness}`} aria-hidden="true" /> {t('source.harness')}
        <span className={`${css.cell} ${css['suspicious-harness']}`} aria-hidden="true" /> {t('verdict.suspicious')}
        <span className={`${css.cell} ${css.uncovered}`} aria-hidden="true" /> {t('verdict.uncovered')}
      </footer>
    </div>
  )
}
