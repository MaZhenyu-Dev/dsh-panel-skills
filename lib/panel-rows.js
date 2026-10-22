/**
 * Read and edit the loader rows that carry one entry id.
 *
 * Two halves of this project act on the same profile patch: the installer
 * (`tools/profile-install.mjs`) writes and removes the hand-installed row, and
 * the host half removes the left-behind override row after the bundle itself is
 * removed. They must agree on what a row is, down to the quoting and block
 * spellings YAML accepts — two readers that disagree are how a document gets a
 * second row for the same id or keeps a row the other side thinks it removed.
 *
 * The functions here are lifted from the installer's implementation, with the
 * entry id made a parameter so the host can use the same code. The backup
 * helpers travel with them because a write that changes the user's document has
 * to leave the previous bytes behind, whichever side performs it.
 *
 * @module patch-rows
 */

import fs from 'node:fs'
import path from 'node:path'

/** Marker used in backup filenames. */
export const BACKUP_SUFFIX = 'bak-dsh-panel-skills'

/** How many of this tool's own backups to keep per file. */
export const KEEP_BACKUPS = 3

/** Distinguishes backups written within the same millisecond. */
let stampCounter = 0

/**
 * A backup stamp that cannot collide inside one process.
 *
 * The stamp was the timestamp alone, so two writes in the same millisecond
 * produced the same name and the second `writeFileSync` truncated the first
 * backup — losing exactly the copy the operation was about to change. A pid and
 * a counter make every name unique, and it stays sortable by time, which is what
 * the retention rule needs.
 *
 * @returns the stamp for a backup name.
 */
export function stampNow() {
  stampCounter += 1
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${stampCounter}`
}

/**
 * The timestamped backups written for one file, oldest first.
 *
 * Only names in this project's own format are matched: the live profile also
 * carries `.bak` files from other hands, and those are not ours to prune or to
 * claim.
 *
 * @param file - the file the backups belong to.
 * @returns absolute backup paths.
 */
export function backupsOfFile(file) {
  const dir = path.dirname(file)
  const prefix = `${path.basename(file)}.${BACKUP_SUFFIX}-`
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .sort()
      .map((name) => path.join(dir, name))
  } catch {
    return []
  }
}

/**
 * Write a file atomically, keeping one timestamped backup of the previous text.
 *
 * Backups are bounded: every write that changes the document used to leave one
 * for ever, so the live profile had accumulated four — two of them this tool's —
 * with nothing anywhere saying so. The newest {@link KEEP_BACKUPS} are kept and
 * older ones of this project's own making are removed; a backup it did not write
 * is never touched.
 *
 * @param file - target path.
 * @param text - next content.
 * @param stamp - timestamp used in the backup name.
 * @returns the backup path, or undefined when there was nothing to back up.
 */
export function writeWithBackup(file, text, stamp) {
  let backup
  try {
    const previous = fs.readFileSync(file, 'utf8')
    if (previous !== text) {
      backup = `${file}.${BACKUP_SUFFIX}-${stamp}`
      fs.writeFileSync(backup, previous)
      for (const older of backupsOfFile(file).slice(0, -KEEP_BACKUPS)) {
        try {
          fs.rmSync(older, { force: true })
        } catch {
          // A backup that cannot be pruned is reported by the installer's status
          // as what it is: residue, not a failure of the write this call is
          // performing.
        }
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // Same atomic shape the profile writer uses: temp file in place, then rename.
  const temp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(temp, text)
  fs.renameSync(temp, file)
  return backup
}

/**
 * Build the readers/writers for one entry id.
 *
 * @param entryId - the profile entry id whose rows are read or removed.
 * @returns the functions that operate on those rows.
 */
export function createPatchRows(entryId) {
  const escaped = String(entryId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  /**
   * A line folded to the shape the patterns below compare against: quotes
   * dropped and any trailing comment removed.
   *
   * Folding quotes is what lets `- "id": x` and `id: 'x'` be the same line — YAML
   * spells them the same thing — without a regex per quoting style.
   *
   * @param line - one document line, or the part of it after the dash.
   * @returns the comparable text.
   */
  function folded(line) {
    return line.replace(/['"]/g, '').replace(/[ \t]*#.*$/, '').trim()
  }

  /**
   * Whether a folded line is the `id: <entryId>` mapping key, in the quoting and
   * spacing YAML tolerates (`id : x`).
   *
   * @param body - a folded line, or the part of it after the dash.
   * @returns whether it declares this entry's id.
   */
  function isEntryIdKey(body) {
    return new RegExp(`^id[ \\t]*:[ \\t]*${escaped}$`).test(body)
  }

  /**
   * Whether one line, on its own, carries this entry's id: `- id: <id>` (under
   * any quoting or spacing) or a flow mapping `- {… id: <id> …}` on the same
   * line.
   *
   * @param line - one document line.
   * @returns whether it names this entry.
   */
  function carriesEntryOnDash(line) {
    const dash = /^[ \t]*-[ \t]*(.*)$/.exec(line)
    if (dash === null) return false
    const body = folded(dash[1])
    if (isEntryIdKey(body)) return true
    if (!/^\{.*\}$/.test(body)) return false
    return new RegExp(`(^|[,{\\s])id[ \\t]*:[ \\t]*${escaped}([ \\t]*[,}]|$)`).test(body)
  }

  /**
   * Locate the first row at or after `from` that carries this entry's id.
   *
   * Every spelling YAML accepts is one row: `- id: x` with or without a trailing
   * comment, a space before the colon or quotes around either; a flow mapping; and
   * a block mapping whose `-` sits alone with the keys on the following, deeper
   * lines — where `id:` may be *any* key, because YAML mappings are unordered.
   *
   * @param lines - the document, split into lines.
   * @param from - first line to inspect.
   * @returns `{ start, indent }`, or undefined when no row names the entry.
   */
  function findEntryRowFrom(lines, from = 0) {
    for (let index = from; index < lines.length; index += 1) {
      const dash = /^([ \t]*)-[ \t]*(.*)$/.exec(lines[index])
      if (dash === null) continue
      const indent = dash[1].length
      if (carriesEntryOnDash(lines[index])) return { start: index, indent }
      if (folded(dash[2]) !== '') continue
      // `-` alone: scan this item's own block for an `id:` key. Deeper `-` lines
      // are nested sequences belonging to the item, so only a line no deeper than
      // the dash ends it.
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const inner = lines[cursor]
        if (inner.trim() === '') {
          const next = lines[cursor + 1]
          if (next === undefined || !/^[ \t]+\S/.test(next)) break
          continue
        }
        if (inner.match(/^[ \t]*/)[0].length <= indent) break
        if (isEntryIdKey(folded(inner))) return { start: index, indent }
      }
    }
    return undefined
  }

  /**
   * Locate the first row that carries this entry's id.
   * @param lines - the document, split into lines.
   * @returns `{ start, indent }`, or undefined when no row names the entry.
   */
  function findEntryRow(lines) {
    return findEntryRowFrom(lines, 0)
  }

  /**
   * The line after the last continuation line of a row.
   * @param lines - the document, split into lines.
   * @param row - the row's start and indent.
   * @returns the exclusive end index.
   */
  function rowEnd(lines, row) {
    let end = row.start + 1
    while (end < lines.length) {
      const line = lines[end]
      if (line.trim() === '') {
        const next = lines[end + 1]
        if (next === undefined || !/^[ \t]+\S/.test(next)) break
      } else if (line.match(/^[ \t]*/)[0].length <= row.indent) break
      end += 1
    }
    return end
  }

  /**
   * Which shape one located row takes: an `insert` member, a top-level `bare`
   * patch, or a row nested under something else.
   * @param lines - the document, split into lines.
   * @param row - the row's start and indent.
   * @returns `insert`, `bare`, or `nested`.
   */
  function shapeOfEntryRow(lines, row) {
    if (row.indent === 0) return 'bare'
    for (let cursor = row.start - 1; cursor >= 0; cursor -= 1) {
      const line = lines[cursor]
      if (line.trim() === '' || line.trimStart().startsWith('#')) continue
      const ownerIndent = line.match(/^[ \t]*/)[0].length
      if (ownerIndent >= row.indent) continue
      return ownerIndent === 0 && /^[ \t]*-[ \t]*insert:[ \t]*$/.test(line) ? 'insert' : 'nested'
    }
    return 'nested'
  }

  /**
   * Every row carrying this entry's id, with its shape, in document order.
   * @param text - patch document text.
   * @returns `{ start, indent, shape }` entries.
   */
  function entryRows(text) {
    const lines = text.split(/\r?\n/)
    const rows = []
    let cursor = 0
    for (;;) {
      const row = findEntryRowFrom(lines, cursor)
      if (row === undefined) break
      rows.push({ ...row, shape: shapeOfEntryRow(lines, row) })
      cursor = rowEnd(lines, row)
    }
    return rows
  }

  /**
   * Which shape the first row carrying this id takes.
   * @param text - patch document text.
   * @returns `insert`, `bare`, `nested`, or `absent`.
   */
  function entryShape(text) {
    const lines = text.split(/\r?\n/)
    const row = findEntryRow(lines)
    return row === undefined ? 'absent' : shapeOfEntryRow(lines, row)
  }

  /** Whether the entry is present in any shape. */
  function hasEntry(text) {
    return entryShape(text) !== 'absent'
  }

  /**
   * Remove every loader row carrying this entry's id: its indented continuation
   * lines, and — when that empties an `insert` list — the `- insert:` row that
   * owned it, which would otherwise be a null list.
   *
   * *Every* row, not the first. Once the plugin has run, the profile legitimately
   * holds two rows for this id: the `insert` that creates the entry, and the
   * top-level override that `settings/mutate` writes to carry `disabledSkills`.
   * Removing only the first left the second behind, where the composer drops it
   * with a `patch: entry … not found` warning — repeating on every start, in a
   * document the installer had just called byte-for-byte restored.
   *
   * @param text - current document text.
   * @returns the next document text, or undefined when nothing matched.
   */
  function withoutEntry(text) {
    const newline = text.includes('\r\n') ? '\r\n' : '\n'
    let kept = text.split(/\r?\n/)
    let removedAny = false

    for (;;) {
      const row = findEntryRow(kept)
      if (row === undefined) break
      removedAny = true
      const start = row.start
      const memberIndent = row.indent
      /** A sibling member of the same insert list starts at the same indent. */
      const sibling = new RegExp(`^[ \\t]{${memberIndent}}-(?:[ \\t]|$)`)
      let end = start + 1
      while (end < kept.length) {
        const line = kept[end]
        if (line.trim() === '') {
          // A blank line ends the item unless the next line continues it.
          const next = kept[end + 1]
          if (next === undefined || !/^[ \t]+\S/.test(next)) break
        } else if (sibling.test(line)) break
        else if (line.match(/^[ \t]*/)[0].length <= memberIndent) break
        end += 1
      }
      // Drop a blank line that only existed to separate the removed item.
      while (end > start && kept[end - 1].trim() === '') end -= 1
      kept = [...kept.slice(0, start), ...kept.slice(end)]

      // An insert list with no members left is a null value, not an empty list.
      let cursor = start - 1
      while (cursor >= 0 && (kept[cursor].trim() === '' || kept[cursor].trimStart().startsWith('#'))) cursor -= 1
      const owner = cursor >= 0 ? /^([ \t]*)-[ \t]*insert:[ \t]*$/.exec(kept[cursor]) : null
      if (owner !== null) {
        const ownerIndent = owner[1].length
        // The member scan has to stop at the end of *this* list. Scanning to the
        // end of the document lets the next top-level row's indented children
        // (`name:`, `config:` — deeper than the `- insert:` line) pass for
        // members, so an emptied `- insert:` survived as a null row.
        const rest = kept.slice(cursor + 1)
        const stop = rest.findIndex((line) =>
          line.trim() !== '' && !line.trimStart().startsWith('#') &&
          line.match(/^[ \t]*/)[0].length <= ownerIndent)
        let members = stop < 0 ? rest : rest.slice(0, stop)
        // Trailing blank lines belong to the *document*, not to the list.
        while (members.length > 0 && members[members.length - 1].trim() === '') {
          members = members.slice(0, -1)
        }
        // A comment is not a member: `- insert:` followed by an indented comment
        // is still a null list.
        const stillMember = members.some((line) => {
          const bare = line.trim()
          return bare !== '' && !bare.startsWith('#') && /^[ \t]/.test(line)
        })
        if (!stillMember) kept = [...kept.slice(0, cursor), ...kept.slice(cursor + 1 + members.length)]
      }
    }

    if (!removedAny) return undefined
    let body = kept.join(newline)
    if (body !== '' && !body.endsWith(newline)) body += newline
    const hasRows = kept.some((line) => /^[ \t]*-/.test(line))
    const hasEmptySequence = kept.some((line) => line.trim() === '[]')
    if (!hasRows && !hasEmptySequence) {
      // With every row gone the document has to keep one sequence node.
      const trimmed = body.replace(/(\r?\n)+$/, '')
      body = `${trimmed === '' ? '' : `${trimmed}${newline}`}[]${newline}`
    }
    return body
  }

  /**
   * Remove only the hand-installed `insert` members that carry this entry's id.
   *
   * Migration has to keep the top-level override row: it carries
   * `disabledSkills` and the MCP snapshot the running plugin wrote, and the
   * bundle patch (not the user layer) is what should create the entry
   * afterwards. Rows in any other shape are left exactly where they are.
   *
   * @param text - current document text.
   * @returns the next document text, or undefined when no insert member matched.
   */
  function withoutInsertMembers(text) {
    const newline = text.includes('\r\n') ? '\r\n' : '\n'
    let kept = text.split(/\r?\n/)
    let removedAny = false

    for (;;) {
      const row = entryRows(kept.join(newline)).find((candidate) => candidate.shape === 'insert')
      if (row === undefined) break
      removedAny = true
      const start = row.start
      const memberIndent = row.indent
      const sibling = new RegExp(`^[ \\t]{${memberIndent}}-(?:[ \\t]|$)`)
      let end = start + 1
      while (end < kept.length) {
        const line = kept[end]
        if (line.trim() === '') {
          const next = kept[end + 1]
          if (next === undefined || !/^[ \t]+\S/.test(next)) break
        } else if (sibling.test(line)) break
        else if (line.match(/^[ \t]*/)[0].length <= memberIndent) break
        end += 1
      }
      while (end > start && kept[end - 1].trim() === '') end -= 1
      kept = [...kept.slice(0, start), ...kept.slice(end)]

      let cursor = start - 1
      while (cursor >= 0 && (kept[cursor].trim() === '' || kept[cursor].trimStart().startsWith('#'))) cursor -= 1
      const owner = cursor >= 0 ? /^([ \t]*)-[ \t]*insert:[ \t]*$/.exec(kept[cursor]) : null
      if (owner !== null) {
        const ownerIndent = owner[1].length
        const rest = kept.slice(cursor + 1)
        const stop = rest.findIndex((line) =>
          line.trim() !== '' && !line.trimStart().startsWith('#') &&
          line.match(/^[ \t]*/)[0].length <= ownerIndent)
        let members = stop < 0 ? rest : rest.slice(0, stop)
        while (members.length > 0 && members[members.length - 1].trim() === '') {
          members = members.slice(0, -1)
        }
        const stillMember = members.some((line) => {
          const bare = line.trim()
          return bare !== '' && !bare.startsWith('#') && /^[ \t]/.test(line)
        })
        if (!stillMember) kept = [...kept.slice(0, cursor), ...kept.slice(cursor + 1 + members.length)]
      }
    }

    if (!removedAny) return undefined
    let body = kept.join(newline)
    if (body !== '' && !body.endsWith(newline)) body += newline
    const hasRows = kept.some((line) => /^[ \t]*-/.test(line))
    const hasEmptySequence = kept.some((line) => line.trim() === '[]')
    if (!hasRows && !hasEmptySequence) {
      const trimmed = body.replace(/(\r?\n)+$/, '')
      body = `${trimmed === '' ? '' : `${trimmed}${newline}`}[]${newline}`
    }
    return body
  }

  return {
    findEntryRow,
    findEntryRowFrom,
    entryRows,
    entryShape,
    hasEntry,
    withoutEntry,
    withoutInsertMembers,
  }
}

