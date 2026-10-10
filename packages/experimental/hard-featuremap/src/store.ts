/**
 * The feature-map database: one SQLite file shared by every project and
 * session of a deployment. Everything in it is derived (from Joern facts and,
 * later, from ledger events), so a file stamped with another schema version
 * is dropped and rebuilt instead of migrated.
 * @module @deepseek-ai/dsh-experimental-hard-featuremap/store
 */

import { mkdir, open } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { HardCallEdge } from './repair.ts'
import type { HardEdgeRow, HardEdgeSource, HardSymbolRow } from './types.ts'
import type { FactModel } from './model.ts'
import type { HardEntryAuth, HardEntryKind, HardEntryPoint, HardHook } from './wordpress.ts'

/** The physical layout version, stored in `PRAGMA user_version`. */
export const HARD_FEATUREMAP_SCHEMA_VERSION = 2

const SCHEMA = `
CREATE TABLE project (
  id INTEGER PRIMARY KEY,
  root TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);
CREATE TABLE snapshot (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  commit_sha TEXT NOT NULL,
  derivation TEXT NOT NULL,
  frameworks TEXT NOT NULL,
  facts_path TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  UNIQUE (project_id, commit_sha, derivation)
);
CREATE TABLE file (
  snapshot_id INTEGER NOT NULL REFERENCES snapshot(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, path)
) WITHOUT ROWID;
CREATE TABLE type (
  snapshot_id INTEGER NOT NULL REFERENCES snapshot(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  file TEXT NOT NULL,
  line INTEGER,
  inherits TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, id)
) WITHOUT ROWID;
CREATE TABLE symbol (
  snapshot_id INTEGER NOT NULL REFERENCES snapshot(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('function', 'method', 'script')),
  owner TEXT,
  file TEXT NOT NULL,
  line INTEGER,
  end_line INTEGER,
  PRIMARY KEY (snapshot_id, id)
) WITHOUT ROWID;
CREATE TABLE call_site (
  snapshot_id INTEGER NOT NULL REFERENCES snapshot(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  caller TEXT NOT NULL,
  name TEXT NOT NULL,
  target TEXT NOT NULL,
  file TEXT NOT NULL,
  line INTEGER,
  dispatch TEXT NOT NULL,
  args TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, seq)
) WITHOUT ROWID;
CREATE TABLE call_edge (
  snapshot_id INTEGER NOT NULL REFERENCES snapshot(id) ON DELETE CASCADE,
  site INTEGER NOT NULL,
  caller TEXT NOT NULL,
  callee TEXT NOT NULL,
  file TEXT NOT NULL,
  line INTEGER,
  source TEXT NOT NULL CHECK (source IN ('joern', 'repair', 'unique-name', 'hook'))
);
CREATE INDEX call_edge_callee ON call_edge (snapshot_id, callee);
CREATE INDEX call_edge_caller ON call_edge (snapshot_id, caller);
CREATE TABLE hook (
  snapshot_id INTEGER NOT NULL REFERENCES snapshot(id) ON DELETE CASCADE,
  site INTEGER NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('register', 'fire')),
  name TEXT,
  callback TEXT,
  callback_text TEXT,
  caller TEXT NOT NULL,
  file TEXT NOT NULL,
  line INTEGER
);
CREATE INDEX hook_name ON hook (snapshot_id, name);
CREATE TABLE entry_point (
  snapshot_id INTEGER NOT NULL REFERENCES snapshot(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  handler TEXT,
  file TEXT NOT NULL,
  line INTEGER,
  auth TEXT NOT NULL,
  guards TEXT NOT NULL
);
CREATE INDEX entry_point_snapshot ON entry_point (snapshot_id, kind);
`

/** What one import writes: the derived rows of one pinned commit. */
export interface HardSnapshotImport {
  /** Absolute target root; it identifies the project across sessions. */
  readonly projectRoot: string
  readonly commit: string
  /** Digest of everything the rows derive from besides the commit. */
  readonly derivation: string
  /** The framework profiles the rows were read with. */
  readonly frameworks: readonly string[]
  readonly factsPath: string
  readonly model: FactModel
  readonly edges: readonly HardCallEdge[]
  readonly hooks: readonly HardHook[]
  readonly entryPoints: readonly HardEntryPoint[]
}

/** Row counts of one imported snapshot. */
export interface HardSnapshotStats {
  readonly files: number
  readonly types: number
  readonly symbols: number
  readonly callSites: number
  readonly edges: Readonly<Record<HardEdgeSource, number>>
  readonly hooks: number
  readonly entryPoints: number
}


type SymbolRecord = {
  id: string
  name: string
  kind: 'function' | 'method' | 'script'
  owner: string | null
  file: string
  line: number | null
  end: number | null
}


/** The open feature-map database. */
export class HardFeatureMapStore {
  private constructor(private readonly db: DatabaseSync) {}

  /**
   * Open or create the database, rebuilding it when its schema version differs.
   * @param path - absolute database file path; missing directories and the file are created owner-only.
   * @returns the open store.
   */
  static async open(path: string): Promise<HardFeatureMapStore> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    try {
      await (await open(path, 'wx', 0o600)).close()
    } catch (error: unknown) {
      // EEXIST: an existing database keeps its mode; anything else is a real failure.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const db = new DatabaseSync(path)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA busy_timeout = 5000')
    const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
    if (version !== HARD_FEATUREMAP_SCHEMA_VERSION) {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
      db.exec('PRAGMA foreign_keys = OFF')
      for (const { name } of tables) db.exec(`DROP TABLE "${name.replaceAll('"', '""')}"`)
      db.exec('PRAGMA foreign_keys = ON')
      db.exec(SCHEMA)
      db.exec(`PRAGMA user_version = ${HARD_FEATUREMAP_SCHEMA_VERSION}`)
    }
    return new HardFeatureMapStore(db)
  }

  /** Close the database handle. */
  close(): void {
    this.db.close()
  }

  /**
   * The snapshot already imported for a project, commit, and derivation.
   * @param projectRoot - absolute target root.
   * @param commit - pinned commit.
   * @param derivation - derivation digest.
   * @returns the snapshot id, or undefined when none was imported.
   */
  findSnapshot(projectRoot: string, commit: string, derivation: string): number | undefined {
    const row = this.db.prepare(`
      SELECT snapshot.id AS id FROM snapshot JOIN project ON project.id = snapshot.project_id
      WHERE project.root = ? AND snapshot.commit_sha = ? AND snapshot.derivation = ?`).get(projectRoot, commit, derivation) as { id: number } | undefined
    return row?.id
  }

  /**
   * Write one snapshot's rows in a single transaction.
   * @param input - the derived rows.
   * @returns the new snapshot id.
   */
  importSnapshot(input: HardSnapshotImport): number {
    const db = this.db
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('INSERT INTO project (root, name) VALUES (?, ?) ON CONFLICT (root) DO NOTHING').run(input.projectRoot, basename(input.projectRoot))
      const { id: projectId } = db.prepare('SELECT id FROM project WHERE root = ?').get(input.projectRoot) as { id: number }
      const frameworks = JSON.stringify(input.frameworks)
      const importedAt = new Date().toISOString()
      const snapshot = Number(db.prepare(`
        INSERT INTO snapshot (project_id, commit_sha, derivation, frameworks, facts_path, imported_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(projectId, input.commit, input.derivation, frameworks, input.factsPath, importedAt).lastInsertRowid)
      const model = input.model
      const file = db.prepare('INSERT INTO file (snapshot_id, path) VALUES (?, ?)')
      for (const path of new Set(model.files)) file.run(snapshot, path)
      const type = db.prepare('INSERT OR IGNORE INTO type (snapshot_id, id, name, file, line, inherits) VALUES (?, ?, ?, ?, ?, ?)')
      for (const t of model.types.values()) type.run(snapshot, t.id, t.name, t.file, t.line, JSON.stringify(t.inherits))
      const symbol = db.prepare('INSERT INTO symbol (snapshot_id, id, name, kind, owner, file, line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      for (const m of model.methods.values()) {
        const kind = m.owner !== null ? 'method' : model.functions.has(m.id) ? 'function' : 'script'
        symbol.run(snapshot, m.id, m.name, kind, m.owner, m.file, m.line, m.end)
      }
      const site = db.prepare('INSERT INTO call_site (snapshot_id, seq, caller, name, target, file, line, dispatch, args) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      model.calls.forEach((c, seq) => {
        site.run(snapshot, seq, c.caller, c.name, c.target, c.file, c.line, c.dispatch, JSON.stringify(c.args))
      })
      const edge = db.prepare('INSERT INTO call_edge (snapshot_id, site, caller, callee, file, line, source) VALUES (?, ?, ?, ?, ?, ?, ?)')
      for (const e of input.edges) edge.run(snapshot, e.site, e.caller, e.callee, e.file, e.line, e.source)
      const hook = db.prepare('INSERT INTO hook (snapshot_id, site, op, name, callback, callback_text, caller, file, line) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      for (const h of input.hooks) hook.run(snapshot, h.site, h.op, h.name, h.callback, h.callbackText, h.caller, h.file, h.line)
      const entry = db.prepare(
        'INSERT INTO entry_point (snapshot_id, kind, key, handler, file, line, auth, guards) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      for (const p of input.entryPoints) entry.run(snapshot, p.kind, p.key, p.handler, p.file, p.line, p.auth, JSON.stringify(p.guards))
      db.exec('COMMIT')
      return snapshot
    } catch (error: unknown) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * Row counts of one snapshot.
   * @param snapshot - snapshot id.
   * @returns the counts.
   */
  stats(snapshot: number): HardSnapshotStats {
    const count = (sql: string): number => (this.db.prepare(sql).get(snapshot) as { n: number }).n
    const edges: Record<HardEdgeSource, number> = { 'joern': 0, 'repair': 0, 'unique-name': 0, 'hook': 0 }
    for (const row of this.db.prepare('SELECT source, COUNT(*) AS n FROM call_edge WHERE snapshot_id = ? GROUP BY source').all(snapshot) as { source: HardEdgeSource; n: number }[]) {
      edges[row.source] = row.n
    }
    return {
      files: count('SELECT COUNT(*) AS n FROM file WHERE snapshot_id = ?'),
      types: count('SELECT COUNT(*) AS n FROM type WHERE snapshot_id = ?'),
      symbols: count('SELECT COUNT(*) AS n FROM symbol WHERE snapshot_id = ?'),
      callSites: count('SELECT COUNT(*) AS n FROM call_site WHERE snapshot_id = ?'),
      edges,
      hooks: count('SELECT COUNT(*) AS n FROM hook WHERE snapshot_id = ?'),
      entryPoints: count('SELECT COUNT(*) AS n FROM entry_point WHERE snapshot_id = ?'),
    }
  }

  /**
   * Every edge into a symbol.
   * @param snapshot - snapshot id.
   * @param symbol - callee symbol id.
   * @returns edges ordered by file and line.
   */
  callers(snapshot: number, symbol: string): HardEdgeRow[] {
    return this.edges('callee', snapshot, symbol)
  }

  /**
   * Every edge out of a symbol.
   * @param snapshot - snapshot id.
   * @param symbol - caller symbol id.
   * @returns edges ordered by file and line.
   */
  callees(snapshot: number, symbol: string): HardEdgeRow[] {
    return this.edges('caller', snapshot, symbol)
  }

  /**
   * One symbol of a snapshot.
   * @param snapshot - snapshot id.
   * @param id - symbol id.
   * @returns the symbol, or undefined when the snapshot has none with that id.
   */
  symbol(snapshot: number, id: string): HardSymbolRow | undefined {
    const row = this.db.prepare('SELECT id, name, kind, owner, file, line, end_line AS end FROM symbol WHERE snapshot_id = ? AND id = ?')
      .get(snapshot, id) as SymbolRecord | undefined
    return row === undefined ? undefined : { ...row }
  }

  /**
   * Symbols whose name or id contains a text, ordered by id.
   * @param snapshot - snapshot id.
   * @param text - the text to look for, matched case-insensitively.
   * @param limit - the most symbols to return.
   * @returns the matching symbols.
   */
  findSymbols(snapshot: number, text: string, limit: number): HardSymbolRow[] {
    const pattern = `%${text.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
    const rows = this.db.prepare(`SELECT id, name, kind, owner, file, line, end_line AS end FROM symbol
      WHERE snapshot_id = ? AND (name LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\') ORDER BY id LIMIT ?`).all(snapshot, pattern, pattern, limit) as SymbolRecord[]
    return rows.map(row => ({ ...row }))
  }

  /**
   * The distinct symbols one symbol calls, by any edge source.
   * @param snapshot - snapshot id.
   * @param symbol - caller symbol id.
   * @returns callee ids ordered by id.
   */
  calleeIds(snapshot: number, symbol: string): string[] {
    return (this.db.prepare('SELECT DISTINCT callee FROM call_edge WHERE snapshot_id = ? AND caller = ? ORDER BY callee')
      .all(snapshot, symbol) as { callee: string }[]).map(row => row.callee)
  }

  /**
   * How many distinct symbols call one symbol.
   * @param snapshot - snapshot id.
   * @param symbol - callee symbol id.
   * @returns the distinct caller count.
   */
  fanIn(snapshot: number, symbol: string): number {
    return (this.db.prepare('SELECT COUNT(DISTINCT caller) AS n FROM call_edge WHERE snapshot_id = ? AND callee = ?').get(snapshot, symbol) as { n: number }).n
  }

  private edges(end: 'caller' | 'callee', snapshot: number, symbol: string): HardEdgeRow[] {
    const rows = this.db.prepare(`SELECT caller, callee, file, line, source FROM call_edge WHERE snapshot_id = ? AND ${end} = ? ORDER BY file, line`)
      .all(snapshot, symbol) as { caller: string; callee: string; file: string; line: number | null; source: HardEdgeSource }[]
    return rows.map(row => ({ ...row }))
  }

  /**
   * The entry points of one snapshot.
   * @param snapshot - snapshot id.
   * @returns entry points ordered by kind and key.
   */
  entryPoints(snapshot: number): HardEntryPoint[] {
    const sql = 'SELECT kind, key, handler, file, line, auth, guards FROM entry_point WHERE snapshot_id = ? ORDER BY kind, key'
    const rows = this.db.prepare(sql).all(snapshot) as {
      kind: HardEntryKind
      key: string
      handler: string | null
      file: string
      line: number | null
      auth: HardEntryAuth
      guards: string
    }[]
    return rows.map(row => ({ ...row, guards: JSON.parse(row.guards) as string[] }))
  }
}
