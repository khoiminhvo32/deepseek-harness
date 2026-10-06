/**
 * Client-safe hard-harness ledger vocabulary for the `hardLedger` projection
 * wire value. Types only: this file rides the browser bundle's type check, so
 * any runtime import here would drag zod, schemastery, or the Host service
 * into the client graph.
 * @module @deepseek-ai/dsh-experimental-hard-ledger/client
 */

export type {
  HardCoverageCellData,
  HardCoverageSource,
  HardCoverageVerdict,
  HardLedgerClientView,
} from './types.ts'
