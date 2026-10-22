/**
 * Host half of dsh-panel-skills.
 *
 * Responsibility: make the skills the user switched off *genuinely* unavailable
 * by shadowing each one with a same-named candidate that is excluded from both
 * the model and the user catalog, and by moving the skill's directory out of
 * every scanned root.
 *
 * ---------------------------------------------------------------------------
 * Why a PROVIDER and not `ctx.skills.register()`
 * ---------------------------------------------------------------------------
 * Candidate ordering in `@deepseek-ai/dsh-skill` is, ascending:
 *
 *     rank  ->  providerOrder  ->  localOrder     (compareIndexedCandidates)
 *
 * Lower wins. Ranks used by the shipped composition:
 *
 *     PROJECT_DSH_RANK     100   (.dsh/skills in the workspace)
 *     PROJECT_AGENTS_RANK  200   (.agents/skills in the workspace)
 *     RUNTIME_RANK         250   <- what ctx.skills.register() uses
 *     CUSTOM_RANK          300   (configured custom paths)
 *     USER_DSH_RANK        400   (~/.dsh/skills)
 *     USER_AGENTS_RANK     500   (~/.agents/skills)
 *     BUNDLED_SKILL_RANK   600   (skills embedded in plugins)
 *
 * `dsh-skill` states the intent plainly: "Project entries outrank runtime
 * entries, which outrank user entries, within one layer."
 *
 * => A *runtime* shadow sits at 250 and therefore CANNOT disable a project-level
 *    skill (100 / 200). This provider uses SHADOW_RANK = 1, which is below every
 *    built-in source, so within the global layer the shadow wins.
 *
 * Rank only orders candidates *inside one layer*: a read merges the global layer
 * with the viewing scope's chain, and the nearest layer's entry wins a duplicate
 * name outright. A skill contributed by an agent preset's own layer therefore
 * stays out of reach (see the README's limitations).
 *
 * ---------------------------------------------------------------------------
 * Why the directory move is still needed
 * ---------------------------------------------------------------------------
 * A preset-scope layer overwrites the global one, so no provider registration
 * can hide a skill that lives in that nearer layer. Moving the directory out of
 * the scanned roots is independent of layers, scopes and registry instances, and
 * the provider's own directory watcher invalidates the catalog as soon as it
 * disappears. The shadow remains the fast path for the global layer; the move is
 * the guarantee.
 *
 * ---------------------------------------------------------------------------
 * Staying current
 * ---------------------------------------------------------------------------
 * `cosmokit`'s volatile reference exposes only `get()`; the write symbol is
 * internal and there is no `subscribe()` on the reference itself. Two things
 * keep this plugin honest:
 *
 *   1. `list()` reads `get()` on every call, so candidate *content* is always
 *      current — the reference is updated in place by the Loader.
 *   2. The registry caches completed catalogs, so a change also needs
 *      `control.invalidate()`. A volatile-only commit is announced as
 *      `loader/volatile-update`, which we listen for — but the Loader filters that
 *      event to the entry's own fiber and this listener lives on a child context,
 *      so in this build `shadowSyncIntervalMs` is the path that actually reacts.
 *      Measured on the installed build; see the note at the subscription.
 *
 * This package is also the only owner of the parked-skill area: the panel's
 * safe-uninstall preparation and the disposal grace both live here, because the
 * code that can put a directory back must not disappear with another bundle.
 */

import z from '@deepseek-ai/schemastery'
import fs from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

import { createPatchRows, stampNow, writeWithBackup } from './panel-rows.js'

/** Cordis plugin name. */
export const name = 'dsh-panel-skills'

/** This plugin's profile entry id: also its settings namespace. */
const ENTRY_ID = 'dsh-panel-skills'

/** The bundle package name the plugin manager installs and removes. */
const SELF_PACKAGE = 'dsh-panel-skills'

/** The profile-row reader/writer shared with the installer. */
const patchRows = createPatchRows(ENTRY_ID)

/** How long a prepared safe uninstall waits for the client's removeBundle call. */
const PREPARED_TTL_MS = 120_000

/**
 * Pending dispose-grace timers, keyed by profile.
 *
 * A new instance applying for the same profile cancels the timer, which is what
 * tells a reload (HMR, disable/enable) from a removal. A process that exits
 * before the timer fires is covered by the process-exit guard below, which runs
 * when the profile no longer selects this bundle or its dependency is gone.
 */
const disposeGraces = new Map()

/** Cancel one profile's pending dispose grace, if any. */
function cancelDisposeGrace(key) {
  const timer = disposeGraces.get(key)
  if (timer === undefined) return
  clearTimeout(timer)
  disposeGraces.delete(key)
}

/**
 * Process-exit restore guards, keyed by profile.
 *
 * A disposal grace is a timer; a process that leaves before it fires restores
 * nothing. `process.on('exit')` still runs on a normal quit, and it is the one
 * path that can put the directories back when the plugin manager removed the
 * bundle a moment before the app closed. The registry lives on `process` so an
 * HMR replacement of this module updates the existing guard instead of adding a
 * second handler.
 */
const EXIT_GUARDS = Symbol.for('dsh-panel-skills.exit-guards')

/** The process-wide guard registry, installed on first use. */
function exitGuards() {
  if (process[EXIT_GUARDS] === undefined) {
    const guards = new Map()
    process[EXIT_GUARDS] = guards
    process.on('exit', () => {
      for (const guard of [...guards.values()]) {
        try {
          guard()
        } catch {
          // Nothing can be reported from an exit handler; each guard logs its
          // own failure while its context is still usable.
        }
      }
    })
  }
  return process[EXIT_GUARDS]
}

/**
 * Register or replace one profile's exit guard.
 * @param owner - the profile key shared with {@link disposeGraces}.
 * @param guard - the synchronous restore check to run at process exit.
 */
function registerExitGuard(owner, guard) {
  exitGuards().set(owner, guard)
}

/**
 * Declared services. Cordis holds `apply()` until every name here is available,
 * so the shadow provider is never skipped because of load order — the shipped
 * skill packages (`dsh-skill-badge`, `-office`, `-filesystem`) declare the same
 * dependency. `apply` still guards with `ctx.get('skills')` for a context that
 * ignores the declaration.
 */
export const inject = ['skills']

/**
 * Settings surfaced to the client through the `settings` Remote.
 *
 * `disabledSkills` is `.volatile()` so `settings/describe` exposes it and the
 * Skills panel can read and write it. NOTE: a volatile field may not be nested
 * inside another volatile field (schemastery `validateVolatileSchema`), so the
 * fields below stay flat.
 */
export const Config = z.object({
  /** Skill names the user switched off, written by the Skills panel. */
  disabledSkills: z.array(z.string()).default([]).volatile(),
  /** How often the host re-reads `disabledSkills`, in milliseconds. */
  shadowSyncIntervalMs: z.natural().default(1000),
  /**
   * Where to write a JSON status document, when support needs to see the host
   * half's side of the story. Empty disables it.
   *
   * The host half has no log file and cannot push to the browser, so its own
   * failures — a service that never resolved, a scope the shadow never reached —
   * are invisible from the panel. This is the opt-in window into that state.
   */
  diagnosticPath: z.string().default(''),
  /**
   * One safe-uninstall preparation from the Skills panel.
   *
   * The panel cannot move skill directories. It writes this request through its
   * own settings namespace; the host restores every parked directory it owns and
   * answers with {@link safeUninstallResult} (`ready` or a refusal). Only then
   * does the panel call the manager's `removeBundle`, so the skills are back
   * before the entry disappears. A directory that cannot be restored refuses the
   * whole uninstall — nothing is removed.
   */
  safeUninstallRequest: z.object({
    nonce: z.string().default(''),
    /** When the panel sent it; a submission older than the window is not replayed. */
    at: z.string().default(''),
  }).default({ nonce: '', at: '' }).volatile(),
  /** The preparation outcome; `ready` means the skills are back and the panel may remove. */
  safeUninstallResult: z.object({
    nonce: z.string().default(''),
    ok: z.boolean().default(false),
    code: z.string().default(''),
    message: z.string().default(''),
    /** How many parked directories this preparation put back. */
    restored: z.natural().default(0),
    at: z.string().default(''),
  }).default({ nonce: '', ok: false, code: '', message: '', restored: 0, at: '' }).volatile(),
  /**
   * How long a disposed host waits for a replacement instance before restoring
   * the parked skills and cleaning a removed bundle's leftover row.
   *
   * The value is the initial 20 s from the M8 plan (S-4c measured that work can
   * still complete after dispose; it did not measure an upper bound). The host
   * test sets a short value; the live default stays generous enough for an HMR
   * reload to re-apply the new instance and cancel it.
   */
  disposeGraceMs: z.natural().default(20_000),
})
/** The parked-skill root the pre-split package used. */
const LEGACY_HIDDEN_DIR = '.mcp-skills-panel-disabled'

/** The package that owned that root. */
const LEGACY_PACKAGE_NAME = 'dsh-plugin-mcp-skills'

/**
 * Whether the pre-split package is still declared by the profile.
 *
 * While it is, its host half still owns the legacy parked area — adopting it
 * would move records out from under a running package. The adoption waits until
 * the old bundle is really gone, which is the "remove first" half of the
 * migration and also the safe order for its data.
 *
 * @param profileDir - the profile directory, when it is known.
 * @returns whether the legacy package is still declared.
 */
function legacyPackageInstalled(profileDir) {
  if (profileDir === undefined) return false
  try {
    const manifest = JSON.parse(fs.readFileSync(join(profileDir, 'package.json'), 'utf8'))
    return manifest?.dependencies?.[LEGACY_PACKAGE_NAME] !== undefined ||
      (manifest?.dsh?.profile?.bundles ?? []).includes(LEGACY_PACKAGE_NAME)
  } catch {
    // Unreadable counts as "not installed": the profile is not this package's to
    // interpret, and a wrong refusal would keep the adoption off for ever.
    return false
  }
}

/**
 * Adopt the pre-split parked area, once.
 *
 * The split renamed the package and the parked root with it. Renaming the
 * directory keeps every record's absolute `from` and its profile owner valid,
 * but a v2 record also carries `to` — the parked path — so each record is
 * rewritten to the new root in the same pass. If the rename cannot happen, the
 * old directory is left exactly where it is and the failure is reported: two
 * parked areas are never merged.
 *
 * @param profileDir - the profile directory, when it is known.
 * @returns a failure sentence, or undefined when there was nothing to do.
 */
function adoptLegacyHiddenRoot(profileDir) {
  if (legacyPackageInstalled(profileDir)) {
    return 'the pre-split package is still installed; its parked area is left to it'
  }
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const legacy = join(home, LEGACY_HIDDEN_DIR)
  const current = hiddenRoot()
  if (!fs.existsSync(legacy)) return undefined

  if (fs.existsSync(current)) {
    // A refused attempt can still leave of the new root only what this package
    // derives: the index and a restore report. Those are ours to drop, which is
    // what makes the next start retry instead of skipping for ever. Anything
    // else is real parked data, and two non-empty areas are never merged.
    let entries
    try {
      entries = fs.readdirSync(current)
    } catch (error) {
      return `the new parked root cannot be read: ${String(error?.message ?? error)}`
    }
    const derived = new Set(['manifest.json', 'restore-report.json'])
    if (!entries.every((name) => derived.has(name))) {
      return `both ${legacy} and ${current} hold data; they are never merged`
    }
    try {
      for (const name of entries) fs.rmSync(join(current, name), { force: true })
      fs.rmdirSync(current)
    } catch (error) {
      // Handed back to the sweep, which reports it: a silent skip would leave the
      // adoption looking done while the legacy area stays stranded.
      return `the empty new parked root could not be removed: ${String(error?.message ?? error)}`
    }
  }

  try {
    fs.renameSync(legacy, current)
  } catch (error) {
    // Reported by the sweep, never swallowed: this is the one failure that keeps
    // a person's switched-off skills out of the running plugin's view.
    return `the rename failed: ${String(error?.message ?? error)}`
  }
  return rewriteAdoptedRecords(current)
}

/**
 * Point every adopted record's `to` at the new parked root.
 *
 * `to` is not decorative: `recordProblem` compares it with the current parked
 * path, so a renamed root would make every record look like it describes some
 * other directory. Each file is rewritten in place (same name, atomic rename) so
 * a record whose JSON `name` differs from its filename cannot be duplicated.
 *
 * @param root - the new parked root.
 * @returns a failure sentence, or undefined.
 */
function rewriteAdoptedRecords(root) {
  const dir = join(root, 'records')
  let files
  try {
    files = fs.readdirSync(dir)
  } catch {
    // No records directory: nothing was parked, so nothing to rewrite.
    return undefined
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    const target = join(dir, file)
    let record
    try {
      record = JSON.parse(fs.readFileSync(target, 'utf8'))
    } catch {
      // An unparsable record is named by the normal scan, which refuses it; there
      // is no safe rewrite for a document nothing can read.
      continue
    }
    if (record === null || typeof record !== 'object' || Array.isArray(record)) continue
    const name =
      typeof record.name === 'string' && record.name !== ''
        ? record.name
        : file.slice(0, -'.json'.length)
    record.to = join(root, 'skills', name)
    const temp = `${target}.tmp-${process.pid}`
    try {
      fs.writeFileSync(temp, `${JSON.stringify(record, undefined, 2)}\n`)
      fs.renameSync(temp, target)
    } catch (error) {
      try {
        fs.rmSync(temp, { force: true })
      } catch {
        // The rename failure below is the fact worth reporting.
      }
      return `the record for "${name}" could not be rewritten: ${String(error?.message ?? error)}`
    }
  }
  return undefined
}

/** @returns whether an error is the Loader's busy signal rather than a refusal. */
const isNestedTransaction = (error) =>
  /HMR transactions cannot be nested/u.test(String(error?.message ?? error))

/**
 * Find this plugin's own settings namespace.
 *
 * The documented id is preferred; a renamed entry is found by the one field only
 * this package declares. Two sides guessing differently is how a result lands in
 * the wrong row.
 *
 * @param settings - the settings service.
 * @returns the namespace, or undefined when neither rule finds one.
 */
async function settingsNamespaceOf(settings) {
  const list = await settings.describe()
  const rows = Array.isArray(list) ? list : []
  const row =
    rows.find((item) => item?.ns === ENTRY_ID) ??
    rows.find((item) => JSON.stringify(item?.schema ?? '').includes('disabledSkills'))
  return row?.ns
}


const emptyUninstallRequest = () => ({ nonce: '', at: '' })

/** The empty safe-uninstall outcome. */
const emptyUninstallResult = () => ({ nonce: '', ok: false, code: '', message: '', restored: 0, at: '' })

/** Fixed sentences for the safe-uninstall outcome, by code. */
const UNINSTALL_MESSAGES = {
  ready: 'every parked skill is back; the panel may remove the bundle',
  parked: 'some skill directories cannot be restored; the uninstall was refused',
  'restore-failed': 'some skill directories could not be restored; the uninstall was refused',
  'not-bundle': 'this plugin is not an installed, removable profile bundle',
  'manager-missing': 'the plugin manager is not available; nothing was changed',
  stale: 'this submission is stale (from an earlier session); nothing was changed',
  invalid: 'the request was malformed; nothing was changed',
  unknown: 'the request could not be completed; nothing was changed',
}

/** The longest nonce this package accepts from the settings document. */
const MAX_UNINSTALL_NONCE = 128

/**
 * How old a safe-uninstall request may be and still be applied.
 *
 * The request lives in the profile patch until its result is published, so a
 * host restart between the two — or a crash — could replay it. Applied within
 * the window it is the user's own last intent (idempotent); applied a day later
 * it is a button nobody is looking at, so it is refused as stale instead.
 */
const REQUEST_TTL_MS = 10 * 60 * 1000

/**
 * Read the safe-uninstall request out of the volatile config.
 *
 * Defensive on purpose: the value arrives from a browser through the settings
 * document, and a malformed one must leave the host half untouched rather than
 * throw inside a poll.
 *
 * @param config - the resolved plugin config.
 * @returns the request, or undefined when there is none.
 */
function readUninstallRequest(config) {
  let raw
  try {
    raw = config.safeUninstallRequest?.get?.() ?? config.safeUninstallRequest
  } catch {
    // Unreadable is "no request"; the schema has already validated the shape.
    return undefined
  }
  if (raw === null || typeof raw !== 'object') return undefined
  const nonce = typeof raw.nonce === 'string' ? raw.nonce : ''
  if (nonce === '') return undefined
  return { nonce, at: typeof raw.at === 'string' ? raw.at : '' }
}

/**
 * Why a safe-uninstall request is not usable, or undefined.
 * @param request - the read request.
 * @returns a short reason, never a value.
 */
function uninstallRequestProblem(request) {
  if (request.nonce.length === 0 || request.nonce.length > MAX_UNINSTALL_NONCE) return 'nonce'
  if (request.at === '') return 'at'
  const at = Date.parse(request.at)
  if (!Number.isFinite(at) || Date.now() - at > REQUEST_TTL_MS) return 'stale'
  return undefined
}

/**
 * The comparison form of a safe-uninstall outcome — `at` excluded.
 * @param result - the outcome document.
 * @returns the stable JSON text.
 */
function uninstallResultStable(result) {
  return JSON.stringify({
    nonce: result?.nonce,
    ok: result?.ok,
    code: result?.code,
    message: result?.message,
    restored: result?.restored,
  })
}
/** Provider name registered with the skill registry. */
const SHADOW_PROVIDER = 'dsh-panel-skills-shadow'

/**
 * Rank of the shadow candidates. Lower wins; every built-in starts at 100
 * (see the module header), so 1 outranks all of them.
 */
const SHADOW_RANK = 1

/**
 * Skill-name grammar, duplicated from `@deepseek-ai/dsh-skill` so this package
 * has no load-time dependency on it. A candidate with an invalid name fails
 * `validateCandidate`, and that runs outside the registry's per-provider guard:
 * one bad name rejects the whole catalog *collection* for every provider, not
 * just this one. Names are therefore filtered before they are returned.
 */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Description carried by a skill that is switched off. */
const SHADOW_DESCRIPTION = 'Disabled in the DSH sidebar.'

/**
 * Read the current disabled set from the volatile config reference.
 * @param config - the resolved plugin config.
 * @returns a sorted, de-duplicated list of usable skill names.
 */
function readDisabled(config) {
  const raw = config.disabledSkills?.get?.() ?? config.disabledSkills ?? []
  if (!Array.isArray(raw)) return []
  const valid = raw.filter((entry) => typeof entry === 'string' && SKILL_NAME.test(entry))
  return [...new Set(valid)].sort()
}

/**
 * The `disabledSkills` entries this build cannot address.
 *
 * Dropping them is necessary — see {@link SKILL_NAME} — but dropping them
 * *silently* loses the user's intent with no trace anywhere: the panel renders
 * nothing for them and no report says why. They are reported instead.
 *
 * @param config - the resolved plugin config.
 * @returns the raw entries the grammar rejects.
 */
function rejectedDisabled(config) {
  const raw = config.disabledSkills?.get?.() ?? config.disabledSkills ?? []
  if (!Array.isArray(raw)) return []
  return raw.filter((entry) => typeof entry !== 'string' || !SKILL_NAME.test(entry))
}

/**
 * Where a disabled skill's directory is parked, and the record that undoes it.
 *
 * Disabling cannot be done by shadowing: a registration lands in the layer of the
 * *accessor's* scope, and a host-plane plugin cannot obtain an accessor bound to a
 * preset's scope — measured on a live profile, every attempt collided in the
 * global layer while the filesystem provider's candidates sat in three scope
 * layers that overwrite it. Moving the directory out of the scanned roots is
 * independent of layers, scopes and registry instances, and the provider's own
 * directory watcher invalidates the catalog as soon as it disappears.
 *
 * @returns the directory that holds parked skills and the manifest.
 */
function hiddenRoot() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, '.dsh-panel-skills-disabled')
}

/** @returns the index path, inside the parked-skill directory. */
function manifestPath() {
  return join(hiddenRoot(), 'manifest.json')
}

/** @returns the directory holding one origin record per parked skill. */
function recordsDir() {
  return join(hiddenRoot(), 'records')
}

/**
 * Where one skill's origin record lives.
 *
 * One file per skill rather than one shared document, so losing or corrupting a
 * record costs exactly one skill instead of every parked skill at once.
 *
 * @param name - skill name.
 * @returns the absolute record path.
 */
function recordPath(name) {
  return join(recordsDir(), `${name}.json`)
}

/**
 * Read one origin record.
 * @param name - skill name.
 * @returns the record, or undefined when there is none to read.
 */
function readRecord(name) {
  return readRecordOutcome(name).record
}

/**
 * Read one origin record, and say why it cannot be used when it cannot be.
 *
 * The record directory is scanned line by line, and the sweep used to treat
 * every unreadable outcome — the file vanished, is not JSON, or carries no
 * `from` — as "no record": a bare `continue` with no report anywhere. A record
 * file that exists but cannot be parsed was therefore the one class of bad
 * record the refusal report did not name, while its parked directory sat in the
 * parked area explained by nothing.
 *
 * @param name - skill name.
 * @returns `{ record }`, or `{ problem }` when one cannot be read.
 */
function readRecordOutcome(name) {
  let text
  try {
    text = fs.readFileSync(recordPath(name), 'utf8')
  } catch (error) {
    return { problem: `it could not be read (${String(error?.code ?? error)})` }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { problem: 'it is not valid JSON' }
  }
  if (typeof parsed?.from !== 'string') {
    return { problem: 'it does not name where the skill came from' }
  }
  return { record: parsed }
}

/**
 * Whether a path lives *strictly inside* one of these directories.
 *
 * Both sides are resolved first, so `..` and a trailing separator cannot smuggle a
 * path past the comparison. A relative path is never inside anything: it is the
 * case that used to move a skill under the host process's working directory.
 *
 * The directory itself is not inside itself. A record names a *skill directory*
 * that lives in a root, never the root — accepting the container let a record
 * rename the whole parked area (its `to` was the parked area itself) or turn a
 * scanned root into one skill's directory (its `from` was the root).
 *
 * @param candidate - the path to judge.
 * @param roots - the directories that may strictly contain it.
 * @returns whether it is strictly inside one of them.
 */
function isInside(candidate, roots) {
  if (typeof candidate !== 'string' || candidate === '' || !isAbsolute(candidate)) return false
  const target = resolve(candidate)
  return roots.some((root) => {
    const base = resolve(root)
    return target !== base && target.startsWith(base.endsWith(sep) ? base : base + sep)
  })
}

/**
 * Whether two paths name the same location.
 *
 * Windows resolves differently-cased spellings of one path to one location, so the
 * comparison folds case there and only there. A record written by this host always
 * carries this host's own spelling; the fold keeps a differently-cased `DSH_HOME`
 * from making the host refuse its own records.
 *
 * @param left - one path.
 * @param right - the other.
 * @returns whether they are the same path.
 */
function samePath(left, right) {
  if (typeof left !== 'string' || left === '' || !isAbsolute(left)) return false
  const a = resolve(left)
  const b = resolve(right)
  if (a === b) return true
  return process.platform === 'win32' && a.toLowerCase() === b.toLowerCase()
}

/**
 * Why a record cannot be trusted, or undefined when it can.
 *
 * A record is evidence for a move, and evidence that is never checked is a way to
 * move a user's directory somewhere it never lived: `restoreSkill` used to rename
 * the parked copy to whatever `from` said, creating the parents on the way, and a
 * relative `from` put the skill under the host process's working directory.
 *
 * Two more facts are load-bearing. The record's `name` is used to build the file
 * path it is read from and removed at (`recordPath`), so a name that climbs out of
 * `records/` made the sweep delete a file that had nothing to do with skills. And
 * the origin has to be strictly inside a root this host actually scans, or the
 * restore cannot be the reverse of a park this host performed.
 *
 * The parked path is checked as an identity, not a containment: `to` must be
 * exactly this skill's parked path. "Somewhere in the parked area" let alpha's
 * record name beta's parked directory, so restoring alpha moved beta's skill.
 *
 * @param record - the parsed record.
 * @param fileBase - the record file's own name, without the extension.
 * @returns a reason fit to print, or undefined.
 */
function recordProblem(record, fileBase) {
  if (typeof record?.name !== 'string' || !SKILL_NAME.test(record.name)) {
    return `it does not name a usable skill (${JSON.stringify(record?.name)})`
  }
  if (record.name !== fileBase) {
    return `it is filed as "${fileBase}" but names "${record.name}"`
  }
  if (!isInside(record.from, userSkillRoots())) {
    return `its origin ${JSON.stringify(record.from)} is not a skill directory inside a root this host scans`
  }
  if (record.to !== undefined && !samePath(record.to, parkPath(record.name))) {
    return `its parked path ${JSON.stringify(record.to)} is not where this skill is parked`
  }
  return undefined
}

/**
 * Write one origin record, atomically.
 *
 * The caller is told whether this worked, because the record is the evidence
 * that makes a move reversible: a move must not proceed without one. An earlier
 * design renamed first and swallowed a failed write, which turned a full disk
 * into silently lost skills.
 *
 * @param record - the record to persist.
 * @returns whether the record is on disk.
 */
function writeRecord(record) {
  const target = recordPath(record.name)
  const temp = `${target}.tmp-${process.pid}`
  try {
    fs.mkdirSync(recordsDir(), { recursive: true })
    fs.writeFileSync(temp, `${JSON.stringify(record, undefined, 2)}\n`)
    fs.renameSync(temp, target)
    return true
  } catch {
    try {
      fs.rmSync(temp, { force: true })
    } catch {
      // Nothing more to do here; the caller is told the write failed.
    }
    return false
  }
}

/**
 * Remove one origin record.
 * @param name - skill name.
 */
function removeRecord(name) {
  try {
    fs.rmSync(recordPath(name), { force: true })
  } catch {
    // A record that cannot be removed is retired by the next sweep, which finds
    // the directory already gone.
  }
}

/**
 * Read the shared index an earlier build wrote, for records it left behind.
 *
 * Only a *legacy* index is evidence. The document this build writes
 * (`renderIndex`) is version 2 and is derived from the records; adopting it
 * would resurrect a record that was lost or refused — with an owner of "" that
 * every profile accepts — and act on evidence no reader checked.
 *
 * @returns the entries it holds.
 */
function readLegacyManifest() {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath(), 'utf8'))
    if (!Array.isArray(parsed?.entries)) return []
    if (parsed.version !== undefined && parsed.version !== 1) return []
    return parsed.entries
  } catch {
    return []
  }
}

/**
 * Every parked skill this installation knows about.
 *
 * The per-skill records are authoritative. A shared-index entry with no record
 * yet is adopted as one, so upgrading does not strand a skill parked by an
 * earlier build.
 *
 * A record whose content cannot be trusted is **not** silently dropped: it is
 * returned in `refused` so the sweep can report it. Dropping it in silence would
 * leave a parked directory that nothing explains, which is the state the orphan
 * report exists to prevent.
 *
 * @returns `{ records, refused }` — the usable records by name, and the files that
 *   were read but refused, with the reason.
 */
function readRecords() {
  const found = new Map()
  const refused = []
  try {
    for (const file of fs.readdirSync(recordsDir())) {
      if (!file.endsWith('.json')) continue
      const base = file.slice(0, -'.json'.length)
      const outcome = readRecordOutcome(base)
      if (outcome.record === undefined) {
        // Listed a moment ago: a file that vanished between the listing and the
        // read is a concurrent sweep finishing, not a bad record. Anything still
        // there but unusable is refused by name, like every other bad record.
        if (!fs.existsSync(recordPath(base))) continue
        refused.push({ file, problem: outcome.problem })
        continue
      }
      const problem = recordProblem(outcome.record, base)
      if (problem !== undefined) {
        refused.push({ file, problem })
        continue
      }
      found.set(outcome.record.name, outcome.record)
    }
  } catch {
    // No records directory yet is the normal case.
  }
  for (const entry of readLegacyManifest()) {
    if (typeof entry?.name !== 'string' || typeof entry?.from !== 'string') continue
    if (found.has(entry.name) || !SKILL_NAME.test(entry.name)) continue
    // A refused record file is the newer, more specific evidence for this name;
    // adopting the index entry anyway would act on evidence the reader refused.
    if (refused.some((item) => item.file === `${entry.name}.json`)) continue
    if (!isInside(entry.from, userSkillRoots())) continue
    found.set(entry.name, {
      version: 1,
      name: entry.name,
      from: entry.from,
      to: entry.to,
      owner: '',
      at: entry.at,
      state: 'parked',
    })
  }
  return { records: found, refused }
}

/**
 * Render the human-readable index of the records.
 *
 * Derived, never authoritative: it exists so a person can see what is parked
 * without decoding the record directory.
 *
 * @param records - the current records, by name.
 * @returns the document text.
 */
function renderIndex(records) {
  const entries = [...records.values()]
    .map(({ name, from, to, owner, at, state }) => ({ name, from, to, owner, at, state }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  return `${JSON.stringify({ version: 2, entries }, undefined, 2)}\n`
}

/**
 * Persist the index, atomically.
 *
 * The failure is *returned*, not swallowed: the caller reports it once and
 * leaves the document unremembered so the next sweep tries again — an index that
 * gave up on its first failure was never rewritten again, in silence.
 *
 * @param document - the rendered index.
 * @returns the failure message, or undefined when it was written.
 */
function persistIndex(document) {
  const temp = `${manifestPath()}.tmp-${process.pid}`
  try {
    fs.mkdirSync(hiddenRoot(), { recursive: true })
    fs.writeFileSync(temp, document)
    fs.renameSync(temp, manifestPath())
    return undefined
  } catch (error) {
    // Handed back to the caller, which reports it — returning is this catch's way
    // of saying why the write may fail silently here.
    return String(error?.message ?? error)
  }
}

/** @returns the user-level roots the filesystem provider scans for skills. */
function userSkillRoots() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const agents = process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents')
  return [join(home, 'skills'), join(agents, 'skills')]
}

/**
 * Locate one skill's directory inside the user-level roots.
 *
 * Only user roots are searched: they are derivable without a session, so a
 * project-level skill is reported as unfindable rather than silently ignored.
 *
 * @param name - kebab-case skill name.
 * @returns the absolute directory, or undefined.
 */
function findSkillDirectory(name) {
  return findSkillDirectories(name)[0]
}

/**
 * Locate every directory one skill name maps to, across the user-level roots.
 *
 * Both roots are scanned by the catalogue, which unions them, so the same name can
 * be offered twice. Parking one copy leaves the other one live.
 *
 * @param name - kebab-case skill name.
 * @returns the absolute directories, in scan order.
 */
function findSkillDirectories(name) {
  const found = []
  for (const root of userSkillRoots()) {
    let entries
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      // Not in this root; keep looking.
      continue
    }
    // The directory's *own* spelling is what gets recorded and restored. Joining
    // the settings name onto the root instead answers for a differently-spelled
    // directory on this case-insensitive filesystem and hands back the settings
    // spelling, so a park-and-restore renamed `Demo-Skill` to `demo-skill`.
    const match = entries.find((entry) => entry.name.toLowerCase() === name.toLowerCase())
    if (match === undefined) continue
    const candidate = join(root, match.name)
    try {
      if (fs.statSync(candidate).isDirectory()) found.push(candidate)
    } catch {
      // A file, or a link whose target is gone.
    }
  }
  return found
}

/**
 * Find directories that *declare* this skill name, whatever they are called.
 *
 * The registry names a skill from its `SKILL.md` frontmatter and enumerates
 * `<root>/<dir>/SKILL.md` — the directory name is irrelevant to it. This plugin
 * addresses a skill by its directory, so a directory that does not share the name
 * cannot be moved. Finding it anyway lets the report say that, instead of "no
 * skill directory", which sends the reader looking for a missing file rather than
 * at the directory that is plainly there.
 *
 * Only called when the direct lookup failed, so it costs nothing per tick.
 *
 * @param name - kebab-case skill name.
 * @returns the absolute directories whose frontmatter claims the name.
 */
function findDirectoriesDeclaring(name) {
  const found = []
  for (const root of userSkillRoots()) {
    let entries
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === name) continue
      try {
        const text = fs.readFileSync(join(root, entry.name, 'SKILL.md'), 'utf8')
        const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
        const declared = frontmatter === null
          ? null
          : /^name:[ \t]*['"]?([A-Za-z0-9_-]+)['"]?[ \t]*$/m.exec(frontmatter[1])
        // The name is *compared*, not just found: matching any frontmatter `name:`
        // made every directory that declares some other skill read as a provider of
        // this one, which sent the reader looking in the wrong place.
        if (declared !== null && declared[1] === name) found.push(join(root, entry.name))
      } catch {
        // No SKILL.md, or unreadable: not this skill.
      }
    }
  }
  return found
}

/** @returns where one skill's directory is parked. */
function parkPath(name) {
  return join(hiddenRoot(), 'skills', name)
}

/**
 * A stable name for the profile this instance is running under.
 *
 * Skill roots are shared between profiles, but their disable lists are not, so
 * parked state has to say which instance it belongs to. Without that, two
 * running instances unpark each other's skills on every tick — the directory
 * flapping between two places — and race on the records while doing it.
 *
 * @param ctx - the host context.
 * @returns the profile directory, or '' when the host does not expose one.
 */
function ownerOf(ctx) {
  const profile = lookup(ctx, 'profileContext')
  const dir = profile?.dir ?? profile?.patchPath
  if (typeof dir !== 'string' || dir === '') return ''
  try {
    return fs.realpathSync.native(dir)
  } catch {
    return dir
  }
}

/**
 * Whether this instance may act on a record.
 *
 * An unattributed record — and any record seen by a host that cannot say which
 * profile it is — counts as ours, which preserves the earlier behaviour instead
 * of stranding a skill that nobody would then restore.
 *
 * @param record - the origin record.
 * @param owner - this instance's owner id.
 * @returns whether the record is ours to move.
 */
function isOurs(record, owner) {
  if (owner === '') return true
  const recorded = typeof record.owner === 'string' ? record.owner : ''
  return recorded === '' || recorded === owner
}

/**
 * Move one skill directory into the parked area.
 *
 * The intent is recorded first — atomically, and a failed write aborts the
 * operation — before anything moves. That ordering is what makes the move
 * recoverable: from here on a crash leaves evidence of where the directory
 * belongs, and the sweep can finish or undo the move.
 *
 * @param name - skill name.
 * @param from - its current directory.
 * @param owner - this instance's owner id.
 * @returns the directory it was parked at.
 */
function startPark(name, from, owner) {
  const to = parkPath(name)
  if (fs.existsSync(to)) throw new Error(`already parked at ${to}`)
  const record = {
    version: 2,
    name,
    from,
    to,
    owner,
    at: new Date().toISOString(),
    state: 'parking',
  }
  if (!writeRecord(record)) {
    throw new Error(`could not record where ${from} belongs; refusing to move it`)
  }
  try {
    fs.mkdirSync(join(hiddenRoot(), 'skills'), { recursive: true })
    fs.renameSync(from, to)
  } catch (error) {
    // The move did not happen, so the record must not survive it: a `parking`
    // record for a directory that never left is retried every sweep and reported
    // as a move that is somehow still pending — for ever, in the cross-volume
    // case, where no retry can ever succeed (EXDEV, G6). Undo the intent and say
    // why the skill stays where it is.
    removeRecord(name)
    throw new Error(`could not move ${from} to ${to}: ${String(error?.message ?? error)}`)
  }
  markParked(record)
  return to
}

/**
 * Mark a recorded move as complete.
 * @param record - the record to update.
 */
function markParked(record) {
  writeRecord({ ...record, state: 'parked' })
}

/**
 * Put one parked skill back where its record says it came from.
 *
 * The origin is never inferred. An earlier build, faced with a directory whose
 * record was gone, looked for "the first user root whose parent exists" — which
 * is always the first candidate — and so moved skills into a root they had
 * never lived in, creating it if necessary.
 *
 * @param name - skill name.
 * @param record - its origin record.
 * @returns what happened, for the trail.
 */
function restoreSkill(name, record) {
  const to = typeof record.to === 'string' ? record.to : parkPath(name)
  // Belt and braces with `recordProblem`: the sweep already refuses records it
  // cannot trust, and the move itself still refuses to be the first thing that
  // finds out. The parked path must be this skill's own, and the origin must be a
  // skill directory strictly inside a scanned root — a container is where no
  // skill lived.
  if (!samePath(to, parkPath(name))) {
    throw new Error(
      `refusing to restore from ${JSON.stringify(to)}: that is not where "${name}" is parked`,
    )
  }
  if (!isInside(record.from, userSkillRoots())) {
    throw new Error(
      `refusing to restore to ${JSON.stringify(record.from)}: not a skill directory inside a root this host scans`,
    )
  }
  if (!fs.existsSync(to)) {
    removeRecord(name)
    return 'nothing parked'
  }
  if (fs.existsSync(record.from)) throw new Error(`target already exists: ${record.from}`)
  fs.mkdirSync(dirname(record.from), { recursive: true })
  fs.renameSync(to, record.from)
  removeRecord(name)
  return 'restored'
}

/**
 * Read an optional service without the inject requirement.
 *
 * Cordis exposes services as context properties, but only for declared
 * dependencies: reading `ctx.<name>` for anything else throws. `ctx.get(name)`
 * is the documented strict-free lookup and returns undefined instead, which is
 * what optional collaborators need.
 *
 * @param ctx - context to read from.
 * @param serviceName - Cordis service name.
 * @returns the service, or undefined when it is not mounted.
 */
function lookup(ctx, serviceName) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(serviceName) : undefined
  } catch {
    return undefined
  }
}

/**
 * The stable identity behind a service accessor.
 *
 * A context-bound service is a fresh proxy on every read (`ctx.skills !==
 * ctx.skills` — measured), so the object itself is never a usable key across
 * reads. Two stable handles exist, in order of trust: the registry's layer table
 * (`layers`, the shipped build) and cordis's own `original` symbol on the
 * accessor. The symbol is what keeps a registry-like service *without* a layer
 * table from being re-registered — and warned about — on every poll (G7).
 *
 * @param service - the accessor, or a plain service object.
 * @returns a stable key for identity comparisons.
 */
function serviceIdentity(service) {
  return service?.layers ?? service?.[Symbol.for('cordis.original')] ?? service
}

/**
 * Poll period, clamped to a sane range.
 *
 * The schema already types this field, but the value is read defensively: a
 * non-finite period would make `setInterval` fire continuously instead of
 * polling, which is a busy loop rather than a slow one.
 *
 * @param value - the configured period in milliseconds.
 * @returns a finite period of at least 100ms.
 */
function pollPeriod(value) {
  const candidate = typeof value === 'number' && Number.isFinite(value) ? value : 1000
  // Both ends are clamped. Node silently rewrites a delay beyond 2^31-1 to 1ms,
  // so the ceiling is not cosmetic: it is the difference between a slow poll and
  // the busy loop this function exists to prevent.
  return Math.min(2 ** 31 - 1, Math.max(100, candidate))
}

/**
 * Compare two already-sorted name lists.
 * @param a - previous list.
 * @param b - next list.
 * @returns whether they hold the same names in the same order.
 */
function sameList(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

export function apply(ctx, config) {
  // This plugin ships its own Skills panel, so the schema-driven settings page
  // must not offer a second, rawer editor for the same field. The documented
  // form is an optional `settings` child that names this plugin's fiber, so a
  // host without the Settings service still runs the shadow provider. Guarded:
  // a cosmetic policy must never be able to abort the shadow registration below.
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['settings'], (settingsCtx) => {
        settingsCtx.effect(
          () => settingsCtx.settings.configure({ auto: false }, ctx.fiber),
          'dsh-panel-skills: settings presentation',
        )
      })
    } catch (error) {
      ctx.logger?.warn?.(
        `[dsh-panel-skills] settings page policy was not registered: ${String(error?.message ?? error)}`,
      )
    }
  }

  /**
   * Register the shadow provider against a context that owns the service.
   *
   * This runs through cordis's `inject` rather than a bare `ctx.get('skills')`
   * check: `get` can legitimately return undefined while the registry's fiber is
   * still coming up, and returning early there is a *silent* no-op — the entry
   * stays active, the settings namespace still works, and the panel looks
   * healthy while nothing is ever shadowed. `inject` runs the callback exactly
   * when the service exists, whatever the entry order.
   *
   * @param host - context to register the provider and effects on.
   * @param skills - the skill registry service.
   * @param entryCtx - the context `apply` was handed. The Loader dispatches
   *   `loader/volatile-update` only to listeners on the entry fiber — measured,
   *   N11 — and `host` is the *child* fiber `ctx.inject` runs its body in, so the
   *   subscription has to be made on `entryCtx` or it is dead code that only
   *   looks like a fast path.
   */
  const register = (host, skills, entryCtx = host) => {
    /** Registration-scoped control handed to the provider factory. */
    /**
     * Build the shadow provider for one registration's lifecycle control.
     *
     * The same provider is registered more than once — once globally and once per
     * agent-preset scope (see `syncScopes`) — so it is a factory, not a single
     * object, and each registration gets its own invalidation handle.
     *
     * @param issued - the registration control handed back by the registry.
     * @returns the provider the registry collects candidates from.
     */
    const shadowProvider = (issued) => ({
      name: SHADOW_PROVIDER,

      /**
       * Called on every catalog collection, so the disabled set is read fresh.
       * @returns a complete observation of the current shadow candidates.
       */
      async list() {
        const candidates = readDisabled(config).map((skillName) => ({
          name: skillName,
          description: SHADOW_DESCRIPTION,
          invocation: { modelInvocable: false, userInvocable: false },
          source: SHADOW_PROVIDER,
          rank: SHADOW_RANK,
          provider: SHADOW_PROVIDER,
        }))
        return { candidates, complete: true }
      },

      /**
       * Only reachable through an explicit lookup by name: both invocation flags
       * are false, so neither catalog advertises the shadow. Still returns a
       * definition that satisfies the registry's validator.
       * @param candidate - the candidate this provider previously reported.
       * @returns the shadow definition.
       */
      async get(candidate) {
        void issued
        return {
          name: candidate.name,
          description: SHADOW_DESCRIPTION,
          invocation: { modelInvocable: false, userInvocable: false },
          source: SHADOW_PROVIDER,
          provider: SHADOW_PROVIDER,
          content: '',
        }
      },
    })

    /** Every live registration's invalidation handle: the global one and each scope's. */
    const controls = new Set()

    /**
     * Register the shadow into one registry instance and prime its cache.
     *
     * The handle is added to `controls` only once the registration is known to have
     * succeeded, and the returned disposer removes it again. Both matter: the real
     * registry throws on a duplicate provider name — synchronously, before the
     * factory runs — so pushing first left one dead handle behind per failed
     * attempt, and a scope that went away left its handle in the list for the
     * lifetime of this instance while every later change walked it.
     *
     * @param registry - a `skills` service, global or preset-scoped.
     * @returns the registry's own disposer for this registration, plus the handle.
     */
    const registerInto = (registry) => {
      let issued
      const dispose = registry.registerProvider((control) => {
        issued = control
        return shadowProvider(control)
      })
      if (issued !== undefined) controls.add(issued)
      // A scope that already collected a catalog would otherwise serve its
      // pre-registration result until something else invalidated it.
      issued?.invalidate?.()
      return () => {
        if (issued !== undefined) controls.delete(issued)
        dispose?.()
      }
    }

    /** Scope registries already carrying the shadow, keyed by their layer table. */
    const registered = new Map()

    /** Scope keys already mirrored, so a layer that outlives its scope is dropped. */

    /** Why a scope could not be covered, for the opt-in diagnostic. */
    const errors = []

    /** Cap on the reported failures, so a repeating one cannot grow the list. */
    const MAX_ERRORS = 50

    /** Failures seen beyond the cap, reported as a count. */
    let suppressed = 0

    /** Recent meaningful transitions, for the diagnostic's timeline. */
    const events = []

    /** How many transitions the timeline keeps. */
    const MAX_EVENTS = 20

    /**
     * A `skills` accessor bound to one agent's scope, or undefined.
     *
     * Measured on a live profile: `filesystem` candidates land in three separate
     * **scope layers** while a host-side registration lands in the global one,
     * and `collectFresh` merges the global layer first so every nearer layer
     * overwrites it — rank cannot help, because ranks are never compared across
     * layers. A registration files into the layer of the *registry's own scope*,
     * so the only way into a preset's layer is a `skills` accessor that belongs
     * to that scope. An agent's context is exactly that.
     *
     * `presets.serviceFor()` is not a substitute: a preset need not mount a
     * registry of its own, and the shipped ones mount only the filesystem
     * provider, so it returns nothing.
     *
     * @param agent - a live agent from the `agents` service.
     * @returns the scope-bound service, or undefined when there is none to use.
     */
    const skillsForAgent = (agent) => {
      const agentCtx = agent?.ctx
      if (agentCtx === undefined) return undefined
      let value
      try {
        value = agentCtx.skills ?? agentCtx.get?.('skills')
      } catch {
        return undefined
      }
      if (value === undefined || typeof value.registerProvider !== 'function') return undefined
      // A context-bound accessor is a fresh proxy on every read, and it wraps the
      // host registry when the agent's scope provides none. The layer table is a
      // stable identity — but only when both sides have one: two implementations
      // that expose no table are not evidence of being the same registry.
      if (value === skills) return undefined
      const layerTable = skills?.layers
      if (layerTable !== undefined && value.layers === layerTable) return undefined
      // Same registry behind two accessors: the `original` symbol survives the
      // proxy, the object does not (G7).
      const original = value[Symbol.for('cordis.original')]
      if (original !== undefined && original === skills?.[Symbol.for('cordis.original')]) return undefined
      return value
    }

    /**
     * Mirror the shadow into every scope that carries an agent.
     *
     * Re-run on each poll, so a session that starts later — and the scope that
     * comes up with it — is covered without a restart.
     */
    const syncLayers = () => {
      const agents = lookup(host, 'agents')
      let live = []
      try {
        live = agents?.list?.() ?? []
      } catch (error) {
        report(`agents.list() failed: ${String(error?.message ?? error)}`)
      }
      /** Keyed by the layer table (or the accessor's stable original), which
       * identifies a registry across proxies. */
      const wanted = new Map()
      for (const agent of live) {
        const scopedService = skillsForAgent(agent)
        if (scopedService === undefined) continue
        wanted.set(serviceIdentity(scopedService), scopedService)
      }
      for (const [key, scopedService] of wanted) {
        if (registered.has(key)) continue
        try {
          registered.set(key, registerInto(scopedService))
          note('scope-registry-registered', {
            agents: live.length,
            scopes: registered.size,
            layers: describeLayers(),
          })
        } catch (error) {
          // A registry that rejects the name must not take the host half down:
          // the global registration still serves preset-free reads.
          const message = `scope registry: ${String(error?.message ?? error)}`
          report(message)
          host.logger?.warn?.(`[dsh-panel-skills] ${message}`)
        }
      }
      // A scope that went away leaves a stale registration behind; its own
      // disposal usually takes it with it, but dropping it here keeps the map
      // honest either way.
      for (const [key, dispose] of [...registered]) {
        if (wanted.has(key)) continue
        dispose?.()
        registered.delete(key)
      }
    }

    /**
     * Names of the providers one layer holds, for the opt-in diagnostic.
     * @param layer - a registry layer, or undefined.
     * @returns provider names, or an empty list.
     */
    function providerNames(layer) {
      const providers = layer?.providers
      return typeof providers?.keys === 'function' ? [...providers.keys()] : []
    }

    /**
     * Every layer the registry currently holds, for the opt-in diagnostic.
     * @returns the global layer's providers plus one entry per scope layer.
     */
    const describeLayers = () => {
      const layers = skills.layers
      const scopes = layers?.scoped
      return {
        global: providerNames(layers?.global),
        scopes:
          scopes !== undefined && typeof scopes.keys === 'function'
            ? [...scopes.keys()].map((key, index) => ({
                // Layer tables are objects, so `String(key)` rendered every one
                // of them as `[object Object]` — precisely the fact this field
                // exists to establish (which provider landed in which scope)
                // was the one it could not show. An ordinal plus the provider
                // list is at least true and readable.
                key: `scope-${index}`,
                providers: providerNames(scopes.get(key)),
              }))
            : [],
      }
    }

    /**
     * Record a host-side failure once, for the opt-in diagnostic.
     *
     * The list is bounded: a failure that repeats on every poll must not grow it
     * for ever. The earliest entries are kept, because the first failure is
     * usually the cause and the rest are its consequences; anything past the cap
     * is counted instead.
     */
    const report = (message) => {
      if (errors.includes(message)) return
      if (errors.length >= MAX_ERRORS) {
        suppressed += 1
        return
      }
      errors.push(message)
    }

    /**
     * Note one meaningful transition, for the diagnostic's timeline.
     *
     * Never called for the poll itself. This feeds the same document whose
     * "changed?" check decides whether anything is written, so per-tick entries
     * here would rewrite the file on every tick — the defect that made the
     * earlier guard useless.
     *
     * @param stage - short stage name.
     * @param detail - JSON-serialisable context.
     */
    const note = (stage, detail = {}) => {
      events.push({ at: new Date().toISOString(), stage, ...detail })
      if (events.length > MAX_EVENTS) events.shift()
    }

    /**
     * Register this instance's shadow in the global registry, and say so if the
     * registry refuses.
     *
     * It sits here, after {@link report}, because that is what a refusal has to
     * reach — and the throw it guards happens before the factory is ever called,
     * so nothing else in this closure has been set up at the point it fails.
     */
    let disposeProvider
    try {
      disposeProvider = registerInto(skills)
    } catch (error) {
      // The real registry rejects a provider name it already holds, synchronously.
      // This is the only registration without a guard, and `ctx.inject` runs in a
      // *child* fiber — so the throw never reaches `apply()`: cordis logs a line
      // and marks this fiber failed, leaving no provider, no poll, no park/restore
      // and no diagnostic, while the panel goes on drawing switches for a plugin
      // that is not running. Report it and keep whatever still works.
      const message = `global registration failed: ${String(error?.message ?? error)}`
      report(message)
      host.logger?.warn?.(`[dsh-panel-skills] ${message}`)
    }

    /** The profile this instance belongs to; parked records are keyed by it. */
    const owner = ownerOf(host)

    /** The index document last written, so an unchanged one is not rewritten. */
    let indexWritten

    /** The last index-write failure, reported once per distinct failure. */
    let indexFailure = ''

    /**
     * A safe uninstall whose parked skills are already back, waiting for the
     * panel to call `removeBundle`. While it is set, the sweep must not park
     * those skills again: the disabled list still names them, and the whole
     * point is that they are visible before the bundle disappears.
     */
    let prepared

    /** The newest preparation outcome, also exposed in the opt-in diagnostic. */
    let uninstallLastResult

    /**
     * Reconcile the parked-skill area with the disabled set.
     *
     * Runs on every poll, so it is also the crash recovery. Every step is
     * isolated: one skill that cannot be moved is reported and the sweep
     * continues, because a single failing entry must not strand every other
     * skill behind it.
     *
     * @returns the records as they now stand, for the index.
     */
    const syncHidden = () => {
      const disabled = new Set(readDisabled(config))
      const { records, refused } = readRecords()

      // A preparation that never reached removeBundle must not leave disabled
      // skills visible for ever: after the window the sweep parks them again,
      // exactly as the disabled list says.
      if (prepared !== undefined && Date.now() - prepared.at > PREPARED_TTL_MS) {
        prepared = undefined
        note('uninstall-prepared-expired')
      }

      // 1. Bring every recorded skill to the state its record and the disabled
      //    set imply. The filesystem decides what actually happened, because a
      //    crash can land between the record and the rename.
      for (const { file, problem } of refused) {
        // Refused, not ignored: a record this build will not act on still describes
        // a directory the user parked, and saying so is the difference between a
        // state that can be fixed by hand and one that looks like it never existed.
        report(`the record ${file} was not used: ${problem}`)
      }
      for (const [name, entry] of records) {
        try {
          if (!isOurs(entry, owner)) {
            report(`skill "${name}" is parked by another profile; leaving it alone`)
            continue
          }
          const parked = fs.existsSync(parkPath(name))
          const atOrigin = fs.existsSync(entry.from)

          if (entry.state === 'parking') {
            if (parked && !atOrigin) {
              markParked(entry)
              note('skill-park-completed', { name })
            } else if (!parked && atOrigin && disabled.has(name)) {
              fs.mkdirSync(join(hiddenRoot(), 'skills'), { recursive: true })
              fs.renameSync(entry.from, parkPath(name))
              markParked(entry)
              note('skill-park-resumed', { name })
            } else if (!parked && atOrigin) {
              // The move never happened and the skill is wanted back on: drop
              // the intent rather than acting on it.
              removeRecord(name)
              records.delete(name)
              note('skill-park-abandoned', { name })
            } else {
              throw new Error(
                `recorded as mid-move but found ${parked ? 'parked' : 'missing'}` +
                  `${atOrigin ? ' and also at its origin' : ' and not at its origin'}`,
              )
            }
            continue
          }

          if (entry.state === 'parked' && disabled.has(name)) {
            // `parked` is a claim about the filesystem, and only the `parking`
            // state used to check it. A cleanup tool, an antivirus, or a person can
            // move the directory back — or delete it — while the disable list still
            // names the skill. Without this the diagnostic reported `parked: [...]`
            // for a directory that was not there, and the panel showed a settled
            // "switched off" for a skill the catalogue was offering again.
            //
            // This block is only reached while the skill is still listed as off;
            // when it is wanted back on, the restore path below owns the state (a
            // blocked restore is a different, also-reported case).
            if (!parked && atOrigin) {
              // The recorded move was undone. Retire the record so the state
              // converges: step 2 parks it again from where it actually is, and the
              // event says the undo was seen rather than silently ignored.
              removeRecord(name)
              records.delete(name)
              note('skill-park-undone', { name })
              report(
                `skill "${name}" was moved back to ${entry.from} while still listed as off; ` +
                  'parking it again so the list and the directory agree',
              )
              continue
            }
            if (!parked && !atOrigin) {
              report(
                `skill "${name}" is listed as off but its directory is at neither ` +
                  `${entry.from} nor ${parkPath(name)}: there is nothing to restore`,
              )
              continue
            }
            if (parked && atOrigin) {
              // Both copies exist, so nothing can converge without deleting one of
              // them — which this plugin will not do. Say so instead.
              report(
                `skill "${name}" is at ${entry.from} and also parked at ${parkPath(name)}: ` +
                  'it is offered again while listed as off; remove one of the two directories to settle it',
              )
              continue
            }
            if (parked && !atOrigin) {
              // The leftover check at park time only saw the state then. A copy can
              // appear in the *other* root afterwards — the catalogue unions both
              // roots, so it offers the name again while the panel says "switched
              // off". Say so rather than staying silent.
              const leftovers = findSkillDirectories(name)
              if (leftovers.length > 0) {
                report(
                  `skill "${name}" is parked at ${parkPath(name)} but also offered from ` +
                    `${leftovers.join(' and ')}: the catalogue will list it while the copy stays`,
                )
              }
              continue
            }
          }

          if (entry.state !== 'parking' && entry.state !== 'parked') {
            // A state this build does not know — a corrupt record, or one written
            // by a build with a different vocabulary. The bare `continue` that used
            // to be here meant the panel went on saying "switched off" while the
            // directory sat in a scanned root, offered by the catalogue, with
            // nothing anywhere saying the host had not acted.
            report(
              `skill "${name}" has a record in state ${JSON.stringify(entry.state)}, which this ` +
                'build cannot act on: leaving the directory where it is',
            )
            continue
          }

          if (disabled.has(name)) continue
          const what = restoreSkill(name, entry)
          records.delete(name)
          note('skill-restored', { name, what })
        } catch (error) {
          report(`"${name}": ${String(error?.message ?? error)}`)
        }
      }

      // 2. Park what should be parked and has no record yet — unless a safe
      //    uninstall has just restored them and is waiting for the panel's
      //    removeBundle call. Parking them again would undo the preparation.
      if (prepared === undefined) for (const name of disabled) {
        if (records.has(name)) continue
        try {
          const from = findSkillDirectory(name)
          if (from === undefined) {
            const elsewhere = findDirectoriesDeclaring(name)
            report(
              fs.existsSync(parkPath(name))
                ? `skill "${name}" is parked at ${parkPath(name)} with no origin record: ` +
                    'it cannot be restored by this plugin; move it back into a skill root by hand'
                : elsewhere.length > 0
                  ? `skill "${name}" is provided by ${elsewhere.join(' and ')}, whose directory name ` +
                    `is not "${name}": this build addresses a skill by its directory, so it cannot move it`
                  : `no skill directory for "${name}" under ${userSkillRoots().join(' or ')}`,
            )
            continue
          }
          const to = startPark(name, from, owner)
          records.set(name, readRecord(name) ?? { name, from, to })
          // A second root offering the same name stays in a scanned root, where the
          // catalogue will keep offering it. The move cannot cover both, so say so
          // rather than reporting a clean success.
          const leftover = findSkillDirectories(name).filter((directory) => directory !== from)
          if (leftover.length > 0) {
            report(
              `skill "${name}" is also offered from ${leftover.join(' and ')}: only ${from} was moved, ` +
                'so the catalogue may still list it',
            )
          }
          note('skill-parked', { name, from, to })
        } catch (error) {
          report(`park "${name}": ${String(error?.message ?? error)}`)
        }
      }

      // 3. A directory nobody recorded is reported, never moved. Without a
      //    record there is no evidence of where it came from, and guessing is
      //    how a skill ends up in a root it never lived in.
      try {
        for (const name of fs.readdirSync(join(hiddenRoot(), 'skills'))) {
          if (records.has(name) || disabled.has(name)) continue
          report(
            `skill "${name}" is parked at ${parkPath(name)} with no origin record: ` +
              'it cannot be restored by this plugin; move it back into a skill root by hand',
          )
        }
      } catch {
        // No parked directory yet is the normal case.
      }

      return records
    }

    /**
     * Reconcile the parked area, then refresh the derived index if it changed.
     *
     * Returns the records it reconciled, because the caller is usually about to
     * write the diagnostic — and that document reports the parked set. Reading the
     * whole record directory twice per tick was the cost of not passing them on,
     * and the fingerprint guard only ever prevented the *write*, not the reads.
     *
     * @returns the records, by name.
     */
    const runHiddenSync = () => {
      const records = syncHidden()
      const document = renderIndex(records)
      if (document !== indexWritten) {
        const problem = persistIndex(document)
        if (problem === undefined) {
          indexWritten = document
          indexFailure = ''
        } else if (problem !== indexFailure) {
          // Reported once per distinct failure; the document stays unremembered
          // either way, so the next sweep retries instead of never again.
          indexFailure = problem
          report(`the parked-skill index could not be written: ${problem}`)
        }
      }
      return records
    }

    // ------------------------------------------------------- safe uninstall
    // The profile paths are captured while the context is alive: the dispose
    // grace runs after this instance's fiber is gone (S-4f measured that calls
    // and file writes still complete), and looking these up then would depend
    // on a disposed context.
    const profileService = lookup(host, 'profileContext')
    const profileDir =
      typeof profileService?.dir === 'string'
        ? profileService.dir
        : typeof profileService?.patchPath === 'string'
          ? dirname(profileService.patchPath)
          : undefined
    const profilePatch =
      typeof profileService?.patchPath === 'string'
        ? profileService.patchPath
        : profileDir === undefined
          ? undefined
          : join(profileDir, 'cordis.patch.yml')

    /**
     * The skill-root environment this instance was applied under.
     *
     * The disposal grace reads `DSH_HOME`/`DSH_AGENTS_HOME` when its timer
     * fires, long after the apply. In a process that changes them (tests, or a
     * host that re-points its roots), a timer must still act on the directories
     * its own instance was watching — not on whatever the environment says at
     * fire time.
     */
    const graceHome = process.env.DSH_HOME
    const graceAgents = process.env.DSH_AGENTS_HOME

    /**
     * Whether this package is still a dependency of the profile.
     *
     * A disable keeps the dependency (the bundle stays installed) and must keep
     * the override row: it carries `disabledSkills`, and re-enabling uses it to
     * park the same skills again. A removal drops the dependency, and the row is
     * then a bare patch the composer warns about and drops. Unreadable counts as
     * "still installed": keeping the row is reversible; deleting the user's
     * settings is not.
     */
    const packageStillInstalled = () => {
      if (profileDir === undefined) return true
      try {
        const manifest = JSON.parse(fs.readFileSync(join(profileDir, 'package.json'), 'utf8'))
        return manifest?.dependencies?.[SELF_PACKAGE] !== undefined
      } catch {
        return true
      }
    }

    /**
     * Whether the profile still selects this bundle.
     *
     * Disabling removes the name from `dsh.profile.bundles` and keeps the
     * dependency; removing does both. The exit guard needs the difference: a
     * disabled bundle has no host half to run a disposal grace, so a normal quit
     * after the disable is the last chance to put its parked skills back.
     * Unreadable counts as selected — restoring on an ordinary quit would undo a
     * state the user chose.
     *
     * @returns whether the profile's saved selection still names this bundle.
     */
    const bundleSelected = () => {
      if (profileDir === undefined) return true
      try {
        const manifest = JSON.parse(fs.readFileSync(join(profileDir, 'package.json'), 'utf8'))
        const bundles = manifest?.dsh?.profile?.bundles
        return !Array.isArray(bundles) || bundles.includes(SELF_PACKAGE)
      } catch {
        return true
      }
    }

    /**
     * Every owned record that can be put back, and every one that cannot.
     *
     * A record this build cannot act on, a directory at both the origin and the
     * parked path, a directory at neither, and a parked directory with no record
     * are all refusals: moving on would either choose a destination without
     * evidence or strand a directory. They are named, with paths, so the panel
     * can refuse the uninstall and the person can fix the filesystem.
     *
     * @returns the usable records, the blocked names, and the refusal sentences.
     */
    const uninstallPlan = () => {
      const { records, refused } = readRecords()
      const blocked = refused.map((item) => `${item.file}: ${item.problem}`)
      const blockedNames = new Set()
      for (const [name, entry] of records) {
        if (!isOurs(entry, owner)) continue
        if (entry.state !== 'parked' && entry.state !== 'parking') {
          blocked.push(`${name}: record state ${JSON.stringify(entry.state)} cannot be acted on`)
          blockedNames.add(name)
          continue
        }
        const parked = fs.existsSync(parkPath(name))
        const atOrigin = fs.existsSync(entry.from)
        if (parked && atOrigin) {
          blocked.push(`${name}: both ${entry.from} and ${parkPath(name)} exist`)
          blockedNames.add(name)
        } else if (!parked && !atOrigin) {
          blocked.push(`${name}: its directory is at neither ${entry.from} nor ${parkPath(name)}`)
          blockedNames.add(name)
        }
      }
      const orphans = []
      try {
        for (const name of fs.readdirSync(join(hiddenRoot(), 'skills'))) {
          if (!records.has(name)) orphans.push(name)
        }
      } catch {
        // No parked area is the normal case.
      }
      for (const name of orphans) {
        blocked.push(`${name}: parked at ${parkPath(name)} with no origin record`)
      }
      return { records, blocked, blockedNames, orphans }
    }

    /**
     * Put the records back, one at a time.
     * @param records - the record map to mutate as entries are retired.
     * @param blockedNames - records the plan refused; they stay where they are.
     * @returns the names restored and the failures with their paths.
     */
    const restoreRecords = (records, blockedNames) => {
      const restored = []
      const failed = []
      for (const [name, entry] of [...records]) {
        if (blockedNames.has(name) || !isOurs(entry, owner)) continue
        try {
          const what = restoreSkill(name, entry)
          records.delete(name)
          restored.push(name)
          note('skill-restored', { name, what, reason: 'uninstall' })
        } catch (error) {
          failed.push({
            name,
            reason: String(error?.message ?? error),
            from: entry.from,
            to: parkPath(name),
          })
        }
      }
      return { restored, failed }
    }

    /** Rewrite the derived index after a restore, so it cannot resurrect records. */
    const refreshIndex = (records) => {
      const document = renderIndex(records)
      // The exit guard can reach this with nothing restored; a write at exit is
      // not free, and an unchanged document carries no new information.
      if (document === indexWritten) return
      const problem = persistIndex(document)
      if (problem !== undefined) {
        report(`the parked-skill index could not be written after restore: ${problem}`)
        return
      }
      indexWritten = document
      indexFailure = ''
    }

    /**
     * Leave the evidence a best-effort restore could not finish.
     * @param reason - why the restore ran.
     * @param document - the failure document.
     * @returns the write failure, or undefined.
     */
    const writeRestoreReport = (reason, document) => {
      try {
        fs.mkdirSync(hiddenRoot(), { recursive: true })
        fs.writeFileSync(
          join(hiddenRoot(), 'restore-report.json'),
          `${JSON.stringify({ at: new Date().toISOString(), reason, owner, ...document }, undefined, 2)}\n`,
        )
        return undefined
      } catch (error) {
        // Handed back to `runDisposeGrace`, which logs it: the report is the
        // evidence, so its own write failure must not vanish.
        return String(error?.message ?? error)
      }
    }

    /**
     * Remove the profile rows a removed bundle leaves behind.
     *
     * This is the one write the host half makes to the patch file directly. It
     * runs only after the package is gone and only for this plugin's own id; a
     * disabled bundle keeps its row. The shared row writer keeps the previous
     * bytes in a bounded backup, the same way the installer does.
     *
     * @returns the failure, or undefined when there was nothing left to do.
     */
    const removeLeftoverRow = () => {
      if (profilePatch === undefined) return 'the profile patch path is unknown'
      if (packageStillInstalled()) return undefined
      let text
      try {
        text = fs.readFileSync(profilePatch, 'utf8')
      } catch (error) {
        if (error.code === 'ENOENT') return undefined
        return String(error?.message ?? error)
      }
      const next = patchRows.withoutEntry(text)
      if (next === undefined) return undefined
      try {
        writeWithBackup(profilePatch, next, stampNow())
        return undefined
      } catch (error) {
        return String(error?.message ?? error)
      }
    }

    /**
     * Remove the profile module link a removed bundle leaves behind.
     *
     * S-4c measured that `pnpm remove` does not clear the profile's
     * `node_modules` link for a `link:` dependency. The CLI removes it as part
     * of its bundle uninstall; the manager path has only this grace, so it does
     * the same here. A real directory or file at the name is not ours to touch.
     *
     * @returns the failure, or undefined when there was nothing to remove.
     */
    const removeLeftoverProfileLink = () => {
      if (profileDir === undefined) return 'the profile directory is unknown'
      if (packageStillInstalled()) return undefined
      const link = join(profileDir, 'node_modules', SELF_PACKAGE)
      let stat
      try {
        stat = fs.lstatSync(link)
      } catch (error) {
        if (error.code === 'ENOENT') return undefined
        return String(error?.message ?? error)
      }
      if (!stat.isSymbolicLink()) return `${link} is not a link; leaving it alone`
      try {
        fs.rmdirSync(link)
        return undefined
      } catch {
        // A file symlink is removed by unlink; a junction by rmdir. Try the
        // other call, and report both when neither works.
        try {
          fs.unlinkSync(link)
          return undefined
        } catch (error) {
          return String(error?.message ?? error)
        }
      }
    }

    /**
     * Best-effort restore after a disposal that no new instance followed.
     *
     * This is the path for an uninstall started from the plugin manager, which
     * cannot be refused: it restores every directory it can, leaves the ones it
     * cannot exactly where they are, writes a report beside them, and only then
     * removes a removed bundle's leftover row and module link. No throw escapes
     * a timer.
     *
     * @param reason - what caused the restore, for the report.
     */
    const runDisposeGrace = (reason) => {
      const beforeHome = process.env.DSH_HOME
      const beforeAgents = process.env.DSH_AGENTS_HOME
      if (graceHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = graceHome
      if (graceAgents === undefined) delete process.env.DSH_AGENTS_HOME
      else process.env.DSH_AGENTS_HOME = graceAgents
      try {
        const { records, blocked, blockedNames, orphans } = uninstallPlan()
        const { restored, failed } = restoreRecords(records, blockedNames)
        refreshIndex(records)
        const leftover = removeLeftoverRow()
        const leftoverLink = removeLeftoverProfileLink()
        const failures = [
          ...blocked,
          ...failed.map((item) => `${item.name}: ${item.reason}`),
        ]
        if (leftover !== undefined) failures.push(`the leftover profile row: ${leftover}`)
        if (leftoverLink !== undefined) failures.push(`the leftover profile link: ${leftoverLink}`)
        if (failures.length > 0) {
          const problem = writeRestoreReport(reason, {
            restored,
            failed,
            blocked,
            orphans,
            leftover,
            leftoverLink,
          })
          if (problem !== undefined) {
            host.logger?.warn?.(`[dsh-panel-skills] restore report write failed: ${problem}`)
          }
          host.logger?.warn?.(
            `[dsh-panel-skills] ${reason}: ${failures.length} parked item(s) need attention`,
          )
        }
      } catch (error) {
        host.logger?.warn?.(
          `[dsh-panel-skills] ${reason} failed: ${String(error?.message ?? error)}`,
        )
      } finally {
        if (beforeHome === undefined) delete process.env.DSH_HOME
        else process.env.DSH_HOME = beforeHome
        if (beforeAgents === undefined) delete process.env.DSH_AGENTS_HOME
        else process.env.DSH_AGENTS_HOME = beforeAgents
      }
    }

    /**
     * Start the disposal grace for this profile.
     *
     * A new instance applying for the same profile cancels it — that is what
     * tells an HMR reload or a disable/enable from a removal. The timer is
     * unref'd so a desktop shutdown is not held open by it; records that remain
     * are still restorable from the CLI.
     */
    const scheduleDisposeGrace = () => {
      cancelDisposeGrace(owner)
      const wait = Math.max(0, Number(config.disposeGraceMs) || 0)
      const timer = setTimeout(() => {
        disposeGraces.delete(owner)
        runDisposeGrace('dispose grace')
      }, wait)
      if (typeof timer?.unref === 'function') timer.unref()
      disposeGraces.set(owner, timer)
    }

    /**
     * Prepare a safe uninstall: verify the bundle is removable and put every
     * parked skill back. The panel removes the bundle only after this answers
     * `ready`; a refusal leaves the package and every directory untouched.
     *
     * @param request - the safe-uninstall request.
     * @returns the result document to publish.
     */
    const prepareUninstall = async (request) => {
      const result = (code, message, restored = 0) => ({
        nonce: request.nonce,
        ok: code === 'ready',
        code,
        message,
        restored,
        at: new Date().toISOString(),
      })
      const manager = lookup(host, 'pluginManager')
      if (manager === undefined || typeof manager.removeBundle !== 'function') {
        return result('manager-missing', UNINSTALL_MESSAGES['manager-missing'])
      }
      let bundle
      try {
        // The service method is synchronous in the manager class, but Cordis's
        // host-side proxy may hand it over as an async method. Accept both:
        // treating a Promise as "no bundle" produced a false `not-bundle` on the
        // live profile.
        const listed = manager.listBundles?.()
        const bundles = listed !== null && typeof listed?.then === 'function'
          ? await listed
          : listed
        bundle = Array.isArray(bundles)
          ? bundles.find((item) => item?.name === SELF_PACKAGE)
          : undefined
      } catch (error) {
        report(`safe uninstall: listBundles failed (${String(error?.name ?? 'Error')})`)
        return result('unknown', UNINSTALL_MESSAGES.unknown)
      }
      if (bundle === undefined || bundle.installed !== true || bundle.removable !== true) {
        return result('not-bundle', UNINSTALL_MESSAGES['not-bundle'])
      }
      const { records, blocked, blockedNames } = uninstallPlan()
      if (blocked.length > 0) {
        return result('parked', `${UNINSTALL_MESSAGES.parked}: ${blocked.join('; ')}`)
      }
      const { restored, failed } = restoreRecords(records, blockedNames)
      refreshIndex(records)
      if (failed.length > 0) {
        return result(
          'restore-failed',
          `${UNINSTALL_MESSAGES['restore-failed']}: ` +
            failed.map((item) => `${item.name} (${item.reason})`).join('; '),
        )
      }
      prepared = { at: Date.now(), nonce: request.nonce }
      return result('ready', UNINSTALL_MESSAGES.ready, restored.length)
    }

    // The submission nonce already handled, seeded from a request whose result
    // the Loader carried too — a host restart must not replay it.
    const carriedUninstallRequest = readUninstallRequest(config)
    const carriedUninstallResult =
      config.safeUninstallResult?.get?.() ?? config.safeUninstallResult ?? emptyUninstallResult()
    let uninstallNonceHandled =
      carriedUninstallRequest !== undefined && carriedUninstallResult?.nonce === carriedUninstallRequest.nonce
        ? carriedUninstallRequest.nonce
        : ''

    /** Whether a preparation is being computed right now. */
    let uninstallInFlight = false

    /** What the result comparator has seen — `at` excluded, like every other write. */
    let uninstallResultAttempted =
      carriedUninstallResult?.nonce !== undefined && carriedUninstallResult.nonce !== ''
        ? uninstallResultStable(carriedUninstallResult)
        : ''

    /** Whether a result write is in flight: writes are serialized. */
    let uninstallResultWriting = false

    /**
     * Publish one preparation outcome, clearing the request in the same write.
     * Same single-flight and bounded-conflict discipline as the edit result.
     * @param result - the outcome to publish.
     */
    const commitUninstallResult = (result) => {
      const stable = uninstallResultStable(result)
      if (stable === uninstallResultAttempted || uninstallResultWriting) return
      const settings = lookup(host, 'settings')
      if (settings === undefined || typeof settings.mutate !== 'function') {
        report('safe uninstall: the `settings` service cannot write; the outcome cannot be published')
        return
      }
      uninstallResultWriting = true
      uninstallResultAttempted = stable
      const handledNonce = result.nonce
      const publish = async () => {
        const ns = await settingsNamespaceOf(settings)
        if (ns === undefined) throw new Error('this plugin has no settings namespace')
        for (let attempt = 0; ; attempt += 1) {
          const list = await settings.describe()
          const row = (Array.isArray(list) ? list : []).find((item) => item?.ns === ns)
          const ops = [{ op: 'set', path: ['safeUninstallResult'], value: result }]
          const fresh = readUninstallRequest(config)
          if (fresh?.nonce === handledNonce) {
            ops.push({ op: 'set', path: ['safeUninstallRequest'], value: emptyUninstallRequest() })
          }
          try {
            await settings.mutate(ns, ops, row?.revision)
            return
          } catch (error) {
            const busy = error?.name === 'SettingsConflictError' || isNestedTransaction(error)
            if (attempt < 2 && busy) continue
            throw error
          }
        }
      }
      publish()
        .catch((error) => {
          // Left un-attempted so the next sweep retries; the panel's budget then
          // says "unconfirmed" rather than inventing an outcome.
          if (uninstallResultAttempted === stable) uninstallResultAttempted = ''
          report(`safe uninstall: the outcome could not be published (${String(error?.message ?? error)})`)
        })
        .finally(() => {
          uninstallResultWriting = false
        })
    }

    /**
     * Process at most one safe-uninstall request per sweep.
     *
     * Only on the poll, like the edit request: a request written through
     * `settings/mutate` arrives inside the Loader's transaction, where the
     * services this preparation uses (and the settings write itself) are refused
     * as nested. The poll is the path that already does the writes.
     */
    const syncUninstallRequest = () => {
      if (uninstallLastResult !== undefined) commitUninstallResult(uninstallLastResult)
      const request = readUninstallRequest(config)
      if (request === undefined || request.nonce === uninstallNonceHandled || uninstallInFlight) return
      const problem = uninstallRequestProblem(request)
      if (problem !== undefined) {
        uninstallNonceHandled = request.nonce
        const result = {
          ...emptyUninstallResult(),
          nonce: request.nonce,
          code: problem === 'stale' ? 'stale' : 'invalid',
          message: problem === 'stale'
            ? UNINSTALL_MESSAGES.stale
            : UNINSTALL_MESSAGES.invalid,
          at: new Date().toISOString(),
        }
        uninstallLastResult = result
        commitUninstallResult(result)
        return
      }
      uninstallNonceHandled = request.nonce
      uninstallInFlight = true
      prepareUninstall(request)
        .then((result) => {
          uninstallLastResult = result
          commitUninstallResult(result)
        })
        .catch((error) => {
          uninstallLastResult = {
            ...emptyUninstallResult(),
            nonce: request.nonce,
            code: 'unknown',
            message: UNINSTALL_MESSAGES.unknown,
            at: new Date().toISOString(),
          }
          commitUninstallResult(uninstallLastResult)
          report(`safe uninstall: the worker failed (${String(error?.name ?? 'Error')})`)
        })
        .finally(() => {
          uninstallInFlight = false
        })
    }

    /** The disabled set the catalog cache currently reflects. */
    let applied

    /** Last diagnostic document written, to avoid rewriting an unchanged one. */
    let lastDiagnostic = ''

    /** The last diagnostic-write failure, reported once per distinct failure. */
    let diagnosticFailure = ''

    /**
     * Write the opt-in status document, when `diagnosticPath` names one.
     *
     * Best-effort by design: a diagnostic must never be able to break the
     * feature it exists to explain.
     *
     * The document is only rewritten when its *content* changed. That sounds
     * obvious, but the earlier version compared a document that carried a fresh
     * `at` timestamp, so the comparison could never match and the file was
     * rewritten on every poll — measured at six writes in seven hundred
     * milliseconds with the poll at 100ms. The timestamp is therefore added
     * after the comparison, never before it.
     *
     * @param reason - what just happened, for the reader.
     * @param records - the records the sweep already read, when it has them.
     */
    const writeDiagnostic = (reason, records) => {
      const target = typeof config.diagnosticPath === 'string' ? config.diagnosticPath : ''
      if (target === '') return
      const parked = records ?? readRecords().records
      const snapshot = {
        note: reason,
        disabledSkills: readDisabled(config),
        globalRegistered: Boolean(disposeProvider),
        registrations: controls.size,
        presetScopes: registered.size,
        services: {
          skills: typeof skills.registerProvider === 'function',
          agents: typeof lookup(host, 'agents')?.list === 'function',
          agentPresets: typeof lookup(host, 'agentPresets')?.serviceFor === 'function',
        },
        // A claim about the filesystem, so it is filtered by the filesystem: a
        // record whose directory is at neither recorded path stays in the record
        // set (retried, and reported) but must not be listed as parked.
        parked: [...parked.keys()].filter((name) => fs.existsSync(parkPath(name))).sort(),
        roots: userSkillRoots(),
        // The safe-uninstall request/result pair, so a failure that never
        // reaches the panel (the settings write can be refused) is visible.
        uninstall: {
          request: readUninstallRequest(config)?.nonce ?? '',
          result: uninstallLastResult ?? null,
          prepared: prepared !== undefined,
        },
        // Which layer each competing provider actually landed in: the fact that
        // decides whether a rank-1 shadow can win at all.
        layers: describeLayers(),
        errors,
        ...(suppressed > 0 ? { errorsSuppressed: suppressed } : {}),
        events,
      }
      const fingerprint = JSON.stringify(snapshot)
      if (fingerprint === lastDiagnostic) return
      try {
        fs.writeFileSync(
          target,
          `${JSON.stringify({ at: new Date().toISOString(), ...snapshot }, undefined, 2)}\n`,
        )
        lastDiagnostic = fingerprint
        diagnosticFailure = ''
      } catch (error) {
        // Not remembered as written: the parent directory (or a lock) may be
        // mended later, and a diagnostic that gave up on its first failure stays
        // absent exactly when someone starts looking for it. `report` deduplicates,
        // so a permanent failure is recorded once, not once per tick.
        lastDiagnostic = ''
        const message = String(error?.message ?? error)
        if (message !== diagnosticFailure) {
          diagnosticFailure = message
          report(`the diagnostic could not be written: ${message}`)
          host.logger?.warn?.(`[dsh-panel-skills] diagnostic write failed: ${message}`)
        }
      }
    }

    /**
     * Invalidate the catalog cache when the disabled set actually changed.
     * @returns whether a change was observed.
     */
    const sync = () => {
      const next = readDisabled(config)
      for (const entry of rejectedDisabled(config)) {
        report(`"${String(entry)}" is not a usable skill name, so it is ignored`)
      }
      const changed = applied === undefined || !sameList(applied, next)
      applied = next
      if (changed) for (const control of controls) control.invalidate?.()
      return changed
    }
    /**
     * One pass: mirror the scopes, reconcile the parked area, write the
     * diagnostic once — with the records the sweep just read, not a second read
     * of them.
     *
     * Guarded as a whole, because every caller is a place where a throw is either
     * an uncaught exception or a dead feature:
     *
     *   - `setInterval` turns a throwing callback into an uncaught exception;
     *   - the effect body runs during `apply`, where a throw costs the poll
     *     interval and freezes the disabled set at its apply-time value — the
     *     outcome the poll exists to prevent;
     *   - a Loader event handler has nowhere to report to, and the parked area is
     *     exactly where a silent failure costs data.
     *
     * The settings *write* for a submitted uninstall runs on the poll only. A
     * `loader/volatile-update` listener is dispatched inside the Loader's commit
     * transaction, where the settings service refuses a write as nested; the
     * event path still does all the immediate work (scope mirroring, parking, the
     * diagnostic), and the poll remains the writer.
     *
     * @param reason - what this pass is, for the diagnostic.
     */
    const sweep = (reason) => {
      // Every sweep runs against the roots this instance was applied under. A
      // long-lived poll must not start watching a different home just because
      // the process environment changed (the host tests point it at throwaway
      // homes; a real host could reload profiles in one process).
      const beforeHome = process.env.DSH_HOME
      const beforeAgents = process.env.DSH_AGENTS_HOME
      if (graceHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = graceHome
      if (graceAgents === undefined) delete process.env.DSH_AGENTS_HOME
      else process.env.DSH_AGENTS_HOME = graceAgents
      try {
        let changed = false
        try {
          const adoptionProblem = adoptLegacyHiddenRoot(owner)
          if (adoptionProblem !== undefined) {
            report(`the pre-split parked area could not be adopted: ${adoptionProblem}`)
          }
          changed = sync()
          syncLayers()
          const records = runHiddenSync()
          if (reason === 'poll') syncUninstallRequest()
          writeDiagnostic(changed ? `${reason}: disabled set committed` : reason, records)
        } catch (error) {
          report(`${reason}: ${String(error?.message ?? error)}`)
          note('sweep-failed', { reason, error: String(error?.stack ?? error) })
          try {
            writeDiagnostic(`${reason} failed`)
          } catch {
            // The diagnostic must not be able to mask the failure it reports.
          }
        }
        return changed
      } finally {
        if (beforeHome === undefined) delete process.env.DSH_HOME
        else process.env.DSH_HOME = beforeHome
        if (beforeAgents === undefined) delete process.env.DSH_AGENTS_HOME
        else process.env.DSH_AGENTS_HOME = beforeAgents
      }
    }

    host.effect(
      () => {
        // A replacement instance for this profile cancels the disposal grace:
        // this is an HMR reload or a disable/enable, not a removal.
        cancelDisposeGrace(owner)
        // A normal quit still runs `exit` handlers even though the unref'd grace
        // timer never fires. Register the guard here, where the profile paths and
        // the current record helpers are captured. A replacement apply replaces
        // it, and dispose deliberately leaves it in place: the removal that
        // matters most is the one that unloads this instance.
        registerExitGuard(owner, () => {
          try {
            // Selected and installed is the ordinary running state: its skills
            // are meant to stay parked until the plugin returns. Anything else —
            // the bundle was disabled, or the package is gone — means no host
            // half will run a grace, so this is the last chance to restore.
            if (packageStillInstalled() && bundleSelected()) return
            runDisposeGrace('process exit')
          } catch (error) {
            host.logger?.warn?.(
              `[dsh-panel-skills] process-exit restore failed: ${String(error?.message ?? error)}`,
            )
          }
        })
        // The list is reset per apply, but not before anything: the global
        // registration is reported *before* this effect body exists, and wiping it
        // here would erase the only trace of a host half that is not running.
        const beforeEffect = [...errors]
        errors.length = 0
        suppressed = 0
        errors.push(...beforeEffect)
        note('shadow-effect-enter', { disabled: readDisabled(config) })
        // Snapshot before anything that could throw: a trail that stops at the
        // last completed stage is what identifies the failing one.
        writeDiagnostic('shadow effect entered')
        sweep('apply')
        note('shadow-ready', {
          disabled: applied,
          scopes: registered.size,
          errors: [...errors],
        })
        host.logger?.info?.(
          `[dsh-panel-skills] shadow provider ready (${applied.length} disabled, ${registered.size} preset scope(s))`,
        )

        // A volatile-only settings write is announced as `loader/volatile-update`.
        //
        // Measured, not assumed (N11, tools/m6-spike.mjs): the Loader dispatches
        // that event with a filter of `owner.fiber === <the entry's fiber>` — a
        // listener registered on the *child* fiber `ctx.inject` runs this body in
        // is filtered out and never fires. The subscription is therefore made on
        // the entry context (`entryCtx`), which is what makes the event a real
        // fast path for this plugin's own writes; the poll below stays as the
        // path that covers everything else.
        const offVolatile =
          typeof entryCtx.on === 'function'
            ? entryCtx.on('loader/volatile-update', () => {
                sweep('volatile update')
              })
            : undefined

        // Each tick also looks for agents that started since the last one: a
        // session created after apply needs the shadow in its own preset scope,
        // and there is no other notification for that.
        const tick = () => {
          sweep('poll')
        }
        const interval = setInterval(tick, pollPeriod(config.shadowSyncIntervalMs))
        // A background poll must not hold the process open.
        if (typeof interval?.unref === 'function') interval.unref()
        return () => {
          if (typeof offVolatile === 'function') offVolatile()
          clearInterval(interval)
          for (const dispose of registered.values()) dispose?.()
          registered.clear()
          disposeProvider?.()
          // The last act of this instance: if no replacement applies within the
          // grace, the parked skills go back and a removed bundle's row is taken
          // out. A replacement cancels this at the top of the next effect body.
          scheduleDisposeGrace()
        }
      },
      'dsh-panel-skills: shadow provider',
    )
  }

  // The diagnostic timeline lives inside the registration, because that is where
  // the state worth reporting exists. "The host half never ran" is answered by
  // the document being absent, not by an entry in it.

  if (typeof ctx.inject === 'function') {
    ctx.inject(['skills'], (skillsCtx) => {
      // `inject` guarantees the service, but read it defensively: a throw here
      // fails the fiber loudly, which the panel now surfaces as a phase.
      const skills = skillsCtx.skills ?? skillsCtx.get?.('skills')
      if (skills === undefined) {
        ctx.logger?.warn?.(
          '[dsh-panel-skills] the `skills` service is not mounted; skill toggles will have no effect',
        )
        return
      }
      register(skillsCtx, skills, ctx)
    })
    return
  }

  // A context without `inject` (the offline test fixture): fall back to the
  // service lookup, and keep the warning so the degradation is never silent.
  const skills = ctx.get('skills')
  if (skills === undefined) {
    ctx.logger?.warn?.(
      '[dsh-panel-skills] the `skills` service is not mounted; skill toggles will have no effect',
    )
    return
  }
  register(ctx, skills)
}