/**
 * Where the pinned commit of an armed matrix lives, as git arguments: every
 * reader of the pinned content — the arming enumeration, citations, the
 * independent reader's worktree — addresses the same git directory through
 * this one choice.
 * @module
 */

/**
 * The git arguments that address the pinned commit of one armed matrix: the
 * harness-owned snapshot's git directory when the arming recorded one. A
 * record that predates snapshots pinned a commit of the target repository
 * itself, which plain `git` reaches when it runs with the target directory as
 * its working directory, so no argument is needed.
 * @param matrix - the armed matrix's optional snapshot.
 * @param matrix.snapshot - the harness-owned snapshot, when recorded.
 * @returns unquoted arguments to place right after `git`; empty for records without a snapshot.
 */
export function pinnedGitArgs(matrix: { readonly snapshot?: { readonly gitDir: string } | undefined }): readonly string[] {
  return matrix.snapshot === undefined ? [] : [`--git-dir=${matrix.snapshot.gitDir}`]
}
