/**
 * Browser half of dsh-panel-skills.
 *
 * Registers one sidebar panel below the built-in "Plugins" entry:
 *   - `skills` (order 2) — available skills, with a real enable/disable switch,
 *     their details, and the safe-uninstall control that belongs to the data
 *     this package protects.
 *
 * Written in the compiled-bundle style (`jsx()` calls rather than JSX syntax) so
 * the package needs no bundler: the DSH web client loads this file through
 * `window.__ModuleLoader__`, and React is taken from the shared module table.
 *
 * Verified contracts (see docs/DSH-MCP与Skills面板-开发文档.md):
 *   - sidebar.panellist: list slot, scope "root", options {name,id,order,label,locale};
 *     the icon component receives { size, active }.
 *   - main: keyed slot; key must equal the panellist id.
 *   - settings.describe() -> { namespaces: [{ ns, value, ... }] }
 *   - settings.mutate(ns, ops, expectedRevision?) where ops = [{op:"set",path:[...],value}]
 *   - session.list() / skills.list({ sessionId }) / workspaceFiles.read(sessionId, path)
 *   - pluginManager.listBundles() / removeBundle(name) / setBundleEnabled(name, enabled)
 */

window.__ModuleLoader__.load({
  id: 'dsh-panel-skills',

  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const { jsx, jsxs } = require('react/jsx-runtime')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    const { useState, useEffect, useCallback, useMemo, useRef } = react
    const { Switch, StateDot, IconRefreshOutlineRegular } = primitives

    /** Dictionary namespace owned by this panel. */
    const NS = 'dshPanelSkills'
    /** Sidebar entry id — verified free (see doc §5.3); also the `main` key. */
    const PANEL_SKILLS = 'skills'
    /** This package. Its host half carries the shadow provider and the parked data. */
    const SELF_MODULE = 'dsh-panel-skills'
    /** Settings namespace == this plugin's profile entry id. */
    const SETTINGS_NS = 'dsh-panel-skills'
    /** Shared empty list, so derived values keep a stable identity across renders. */
    const NONE = []

    /** Services required by the sidebar registration and the Remote calls. */
    const inject = [
      'slots',
      'locale',
      'remote',
      'remote.settings',
      'remote.session',
      'remote.skills',
      'remote.workspaceFiles',
      'remote.pluginInventory',
      'remote.pluginManager',
    ]

    // ---------------------------------------------------------------- locale

    const zh = {
      'panel.skills': 'Skills',
      'skills.title': 'Skills',
      'skills.subtitle': '本机可用的技能目录',
      'skills.empty': '没有可显示的技能。',
      'skills.noSession': '没有可用于读取目录的会话',
      'skills.noNamespace':
        '找不到本插件的设置命名空间（需与 profile 条目 id 一致），无法记录关闭名单。',
      'skills.refresh': '刷新',
      'skills.refreshHint': '重新读取技能目录，并让自带的 / 菜单重新拉取',
      'skills.disabled': '已关闭',
      'skills.enabled': '已启用',
      'skills.restoring': '恢复中…',
      'skills.unconfirmed': '未确认',
      'skills.unconfirmed.restoreHint':
        '标有「未确认」的技能在设置里已启用，但目录中始终没有出现：宿主半边可能没有在运行，或其目录已不存在。点「刷新」会重新读取目录；目录里仍没有它，这一行就会结束等待。',
      'skills.unconfirmed.offHint':
        '标有「未确认」的技能在设置里已关闭，但目录仍在提供它：宿主半边尚未完成搬移，或搬移失败。面板不会假装它已被关闭；「刷新」只重新核对两侧，若仍不一致，说明宿主没有完成这次关闭。',
      'skills.caveat':
        '技能目录按会话的工作目录收集，此处显示最近一次更新的会话所属工作区的目录。关闭某个技能时，其目录会被移到 $DSH_HOME/.dsh-panel-skills-disabled/ 并登记在清单里；开启时移回原处。注意：已经打开的对话会缓存自己的 `/` 技能清单，切换后请新开一个对话或刷新页面。',
      'skills.detail': '详情',
      'skills.detail.close': '收起',
      'skills.detail.description': '描述',
      'skills.detail.whenToUse': '何时使用',
      'skills.detail.modelInvocable': '模型可见',
      'skills.detail.path': '路径',
      'skills.detail.noPath':
        '目录没有提供文件路径（内嵌技能等）：只能显示目录给出的字段，SKILL.md 详情不可得。',
      'skills.detail.loading': '读取中…',
      'skills.detail.error': '详情读取失败',
      'skills.detail.noFileApi':
        '本安装不提供文件读取面（workspaceFiles），SKILL.md 详情不可得。',
      'skills.detail.empty': '（文件为空）',
      'skills.detail.lines': '已读 {n} 行',
      'skills.detail.more': '（文件更长，仅显示前 {n} 行）',
      'common.loading': '加载中…',
      'common.error': '出错了',
      'common.retry': '重试',
      'common.filterPlaceholder': '按名或描述过滤…',
      'common.filterClear': '清除过滤',
      'skills.search.none': '没有技能匹配「{q}」',
      'uninstall.title': '安全卸载插件',
      'uninstall.body':
        '这会先把被关闭的技能目录按记录放回原位，再从 DSH 插件管理器卸载本插件。任一目录放不回去（目标被占、记录不可用、目录缺失）都会拒绝卸载；已还原的目录若卸载失败会继续保持可见。',
      'uninstall.open': '安全卸载插件…',
      'uninstall.pageAction': '安全卸载（{n} 个技能已关闭）',
      'uninstall.panelHint':
        '本插件保管着 {n} 个已关闭的技能。卸载请到「插件 → dsh-panel-skills」页面使用安全卸载。',
      'uninstall.refusedShort': '卸载被拒绝（悬停查看原因）',
      'uninstall.retry': '重试',
      'uninstall.confirm': '确认卸载',
      'uninstall.cancel': '取消',
      'uninstall.preparing': '正在还原被关闭的技能…',
      'uninstall.removing': '正在从插件管理器卸载…',
      'uninstall.done': '卸载完成。已关闭的技能已先还原；刷新页面后本面板会消失。',
      'uninstall.notBundle':
        '当前插件不是由插件管理器安装的 profile bundle，面板无法安全卸载；请先确认所有被关闭的技能目录已还原，再从安装位置移除本插件。',
      'uninstall.unavailable': '读不到已安装插件列表，无法判断是否可安全卸载',
      'uninstall.hostDown': '本插件宿主半边未在运行，卸载准备无法送达',
      'uninstall.unconfirmed':
        '宿主没有确认这次卸载准备（宿主半边可能没有在运行）。刷新后重试；若技能已还原，插件仍会按关闭名单再次停放它们。',
      'uninstall.code.parked': '有技能目录无法还原，卸载已拒绝',
      'uninstall.code.restore-failed': '还原技能目录时失败，卸载已拒绝',
      'uninstall.code.not-bundle': '插件管理器不认为这是一个可卸载的 profile bundle',
      'uninstall.code.manager-missing': '插件管理器不可用，未做任何改动',
      'uninstall.code.stale': '这次请求已过期，未做任何改动',
      'uninstall.code.invalid': '请求格式不合法，未做任何改动',
      'uninstall.code.unknown': '卸载准备失败，未做任何改动',
      'uninstall.code.bundle-in-use': '插件管理器拒绝卸载（bundle-in-use）；已尝试恢复启用',
      'uninstall.code.remove-failed': '插件管理器卸载失败；插件仍安装着',
    }

    const en = {
      'panel.skills': 'Skills',
      'skills.title': 'Skills',
      'skills.subtitle': 'Skill catalog available on this machine',
      'skills.empty': 'No skill to display.',
      'skills.noSession': 'no session available to read the catalog',
      'skills.noNamespace':
        'This plugin has no settings namespace (it must match the profile entry id), so the disable list cannot be recorded.',
      'skills.refresh': 'Refresh',
      'skills.refreshHint':
        'Re-read the skill catalog, and make the built-in slash menu fetch it again',
      'skills.disabled': 'Disabled',
      'skills.enabled': 'Enabled',
      'skills.restoring': 'restoring…',
      'skills.unconfirmed': 'unconfirmed',
      'skills.unconfirmed.restoreHint':
        'The skills marked unconfirmed are enabled in the settings but never appeared in the catalog: the host half may not be running, or their directory is gone. Refresh re-reads the catalog; if the name is still absent, the row stops waiting.',
      'skills.unconfirmed.offHint':
        'The skills marked unconfirmed are switched off in the settings but still offered by the catalogue: the host half has not carried the move out, or it failed. The panel does not pretend they are off; a refresh only re-reads both sides, and if they still disagree, the host did not finish this switch-off.',
      'skills.caveat':
        'The catalog is collected per session working directory; this shows the workspace of the most recently updated session. Switching a skill off moves its directory to $DSH_HOME/.dsh-panel-skills-disabled/ and records it in a manifest there; switching it back on restores it. Note that an already-open conversation caches its own `/` skill list, so open a new conversation or refresh after toggling.',
      'skills.detail': 'Details',
      'skills.detail.close': 'Close',
      'skills.detail.description': 'description',
      'skills.detail.whenToUse': 'when to use',
      'skills.detail.modelInvocable': 'model-invocable',
      'skills.detail.path': 'path',
      'skills.detail.noPath':
        'The catalog supplied no file path (bundled skills work this way): only the listed fields are shown, and the SKILL.md detail is unavailable.',
      'skills.detail.loading': 'reading…',
      'skills.detail.error': 'the detail could not be read',
      'skills.detail.noFileApi':
        'This installation offers no file-read surface (workspaceFiles), so the SKILL.md detail is unavailable.',
      'skills.detail.empty': '(the file is empty)',
      'skills.detail.lines': '{n} line(s) read',
      'skills.detail.more': '(the file is longer; showing the first {n} lines)',
      'common.loading': 'Loading…',
      'common.error': 'Something went wrong',
      'common.retry': 'Retry',
      'common.filterPlaceholder': 'Filter by name or description…',
      'common.filterClear': 'Clear filter',
      'skills.search.none': 'no skill matches “{q}”',
      'uninstall.title': 'Safe uninstall',
      'uninstall.body':
        'This puts every switched-off skill directory back where its record says it came from, then removes the whole plugin through the DSH plugin manager. If any directory cannot go back (target occupied, record unusable, directory missing) the uninstall is refused; directories already restored stay visible if the removal fails.',
      'uninstall.open': 'Uninstall safely…',
      'uninstall.pageAction': 'Uninstall safely ({n} disabled)',
      'uninstall.panelHint':
        'This plugin is holding {n} switched-off skill(s). Uninstall from Plugins → dsh-panel-skills with Safe uninstall.',
      'uninstall.refusedShort': 'Uninstall refused (hover for the reason)',
      'uninstall.retry': 'Retry',
      'uninstall.confirm': 'Uninstall',
      'uninstall.cancel': 'Cancel',
      'uninstall.preparing': 'restoring the switched-off skills…',
      'uninstall.removing': 'removing it through the plugin manager…',
      'uninstall.done': 'Uninstalled. The switched-off skills were restored first; this panel disappears after a page refresh.',
      'uninstall.notBundle':
        'This plugin is not a profile bundle installed by the plugin manager, so the panel cannot uninstall it safely; restore any disabled skill directories first, then remove the plugin from wherever it was installed.',
      'uninstall.unavailable': 'the installed-bundle list could not be read, so safe uninstall cannot be offered',
      'uninstall.hostDown': "this plugin's host half is not running, so the preparation cannot arrive",
      'uninstall.unconfirmed':
        'the host did not confirm the uninstall preparation (its half may not be running). Refresh and retry; if the skills were restored, the plugin will park them again from the disabled list.',
      'uninstall.code.parked': 'some skill directories cannot be restored, so the uninstall was refused',
      'uninstall.code.restore-failed': 'restoring skill directories failed, so the uninstall was refused',
      'uninstall.code.not-bundle': 'the plugin manager does not see a removable profile bundle',
      'uninstall.code.manager-missing': 'the plugin manager is not available; nothing was changed',
      'uninstall.code.stale': 'this request was stale; nothing was changed',
      'uninstall.code.invalid': 'the request was malformed; nothing was changed',
      'uninstall.code.unknown': 'the uninstall preparation failed; nothing was changed',
      'uninstall.code.bundle-in-use': 'the plugin manager refused the removal (bundle-in-use); re-enabling was attempted',
      'uninstall.code.remove-failed': 'the plugin manager failed to remove it; the plugin is still installed',
    }
    // ----------------------------------------------------------------- hooks

    /**
     * Run an async loader and expose { status, data, error, reload }.
     * @param load - async function returning the data.
     * @returns the request state plus a manual reload trigger.
     */
    function useAsyncData(load) {
      const [tick, setTick] = useState(0)
      const [state, setState] = useState({ status: 'loading', data: undefined, error: undefined })

      useEffect(() => {
        let live = true
        setState((prev) => ({ ...prev, status: 'loading' }))
        Promise.resolve()
          .then(load)
          .then((data) => {
            if (live) setState({ status: 'ready', data, error: undefined })
          })
          .catch((error) => {
            if (live) setState({ status: 'error', data: undefined, error })
          })
        return () => {
          live = false
        }
        // `load` is recreated per render by callers; `tick` is the real trigger.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [tick])

      const reload = useCallback(() => setTick((n) => n + 1), [])
      return { ...state, reload }
    }

    // ------------------------------------------------------------ shared UI

    const pageStyle = {
      padding: '16px 20px 32px',
      color: 'inherit',
      font: 'inherit',
      overflowY: 'auto',
      height: '100%',
      boxSizing: 'border-box',
    }

    const headerStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      marginBottom: '4px',
    }

    const titleStyle = { fontSize: '15px', fontWeight: 600, margin: 0 }
    const subtitleStyle = { fontSize: '12px', opacity: 0.6, margin: '0 0 14px' }
    const caveatStyle = {
      fontSize: '11px',
      opacity: 0.55,
      lineHeight: 1.5,
      margin: '14px 0 0',
      paddingTop: '10px',
      borderTop: '1px solid currentColor',
      borderColor: 'color-mix(in srgb, currentColor 12%, transparent)',
    }

    /** Inline failure text: a write that did not land must not look like it did. */
    const errorStyle = {
      fontSize: '12px',
      lineHeight: 1.5,
      margin: '0 0 10px',
      color: '#e5534b',
    }

    /** A compact status that fits beside the plugin page's own action buttons. */
    const actionNoteStyle = {
      display: 'inline-block',
      maxWidth: '280px',
      verticalAlign: 'middle',
      fontSize: '11px',
      lineHeight: 1.4,
      opacity: 0.7,
      whiteSpace: 'normal',
    }

    /** The MCP form's box and controls. Plain DOM elements, no new dependencies. */
    const formStyle = {
      margin: '0 0 10px',
      padding: '10px 12px',
      border: '1px solid color-mix(in srgb, currentColor 14%, transparent)',
      borderRadius: '8px',
      display: 'grid',
      gap: '6px',
    }
    const fieldRowStyle = { display: 'flex', alignItems: 'center', gap: '8px' }
    const fieldLabelStyle = { fontSize: '11px', opacity: 0.65, minWidth: '96px' }
    /** Sits under a field, aligned with its control (96px label + 8px gap). */
    const fieldNoteStyle = { fontSize: '11px', opacity: 0.55, margin: '-2px 0 2px 104px' }
    const inputStyle = {
      flex: 1,
      minWidth: 0,
      font: 'inherit',
      fontSize: '12px',
      padding: '3px 6px',
      borderRadius: '6px',
      color: 'inherit',
      background: 'color-mix(in srgb, currentColor 6%, transparent)',
      border: '1px solid color-mix(in srgb, currentColor 16%, transparent)',
    }
    const snippetStyle = {
      ...inputStyle,
      width: '100%',
      boxSizing: 'border-box',
      fontFamily: 'monospace',
      fontSize: '11px',
      whiteSpace: 'pre',
    }

    /**
     * Render a failed write. `role="alert"` keeps it announceable for assistive
     * technology, matching the primitives' accessibility posture.
     * @param props - the message; nothing renders when it is empty.
     * @returns the alert paragraph, or null.
     */
    function ErrorLine({ message }) {
      if (message === undefined || message === null || message === '') return null
      return jsx('p', { role: 'alert', style: errorStyle, children: message })
    }

    const rowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      padding: '10px 0',
      borderBottom: '1px solid color-mix(in srgb, currentColor 10%, transparent)',
    }

    const rowMainStyle = { flex: 1, minWidth: 0 }
    const rowTitleStyle = {
      fontSize: '13px',
      fontWeight: 500,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    }
    const rowMetaStyle = {
      fontSize: '11px',
      opacity: 0.6,
      marginTop: '2px',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    }

    /**
     * Small text button used for refresh / retry.
     *
     * The children go into `props.children` through `jsxs`, which is what the JSX
     * compiler emits for a static child list. They must NOT be passed as extra
     * arguments: `react/jsx-runtime`'s signature is `jsx(type, props, key)`, so a
     * third argument is the element's key and the label and glyph after it are
     * silently dropped — the button renders as an empty pill.
     *
     * @param props - label, hover text, and click handler.
     * @returns the button element.
     */
    function TextButton({ label, title, onClick, disabled }) {
      return jsxs('button', {
        type: 'button',
        onClick,
        disabled,
        title,
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: '4px',
          border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
          background: 'transparent',
          color: 'inherit',
          font: 'inherit',
          fontSize: '12px',
          padding: '3px 8px',
          borderRadius: '6px',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.5 : 1,
        },
        children: [jsx(IconRefreshOutlineRegular, { size: 13 }), label],
      })
    }

    /**
     * A small label-only button (no glyph): row actions such as the MCP form's
     * open/save/copy, where an icon would suggest the wrong thing.
     *
     * @param props - label, accessible name, hover text, handler, disabled.
     * @returns the button element.
     */
    function ActionButton({ label, ariaLabel, title, onClick, disabled }) {
      return jsx('button', {
        type: 'button',
        onClick,
        disabled,
        title,
        'aria-label': ariaLabel ?? label,
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
          background: 'transparent',
          color: 'inherit',
          font: 'inherit',
          fontSize: '12px',
          padding: '3px 8px',
          borderRadius: '6px',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.5 : 1,
        },
        children: label,
      })
    }

    /**
     * The panels' filter box.
     *
     * A native `search` input, so the control is keyboard-reachable and Escape
     * clears it the way the platform's own search fields behave; the clear
     * button is there for the pointer. The query belongs to the panel, which
     * only narrows what it draws — a filtered-out row is not hidden from the
     * toggle that writes the whole list.
     *
     * @param props - query, setter, and the labels the panel supplies.
     * @returns the filter element.
     */
    function FilterBox({ value, onChange, label, clearLabel }) {
      return jsxs('div', {
        style: { display: 'flex', alignItems: 'center', gap: '6px', margin: '0 0 10px' },
        children: [
          jsx('input', {
            type: 'search',
            value,
            'aria-label': label,
            placeholder: label,
            onChange: (event) => onChange(event?.target?.value ?? ''),
            onKeyDown: (event) => {
              if (event?.key === 'Escape') onChange('')
            },
            style: { ...inputStyle, flex: 1 },
          }),
          value === ''
            ? null
            : jsx(ActionButton, {
                label: clearLabel,
                onClick: () => onChange(''),
              }),
        ],
      })
    }

    /**
     * Render one status row shared by both panels.
     * @param props - dot state, title, meta lines, an optional hover text for the
     * meta line, and an optional control.
     * @returns the row element.
     */
    function StatusRow({ dotState, title, meta, metaTitle, control }) {
      return jsxs('div', {
        style: rowStyle,
        children: [
          jsx(StateDot, { state: dotState }),
          jsxs('div', {
            style: rowMainStyle,
            children: [
              jsx('div', { style: rowTitleStyle, children: title }),
              // The meta line is CSS-truncated, so the full text — including
              // the failOnStartupError marker, which sits after a long argv —
              // is one hover away. A native `title`, not `Tooltip`: Tooltip
              // clones its child with a ref these components do not forward.
              meta ? jsx('div', { style: rowMetaStyle, title: metaTitle ?? meta, children: meta }) : null,
            ],
          }),
          control ?? null,
        ],
      })
    }
    function SkillsPanelIcon({ size }) {
      return jsx(primitives.IconSkillOutlineRegular, { size })
    }

    /**
     * How long a just-re-enabled skill is held in the list until the catalog
     * reports it again, and how often the panel re-reads the catalog while it
     * waits.
     *
     * The two facts the list is built from arrive independently. The disable list
     * is part of the settings document, so it changes the moment a write is
     * acknowledged; the catalog regains a name only after the host half has moved
     * the parked directory back into a scanned root — it does that on the settings
     * commit and on the poll that follows — and the filesystem provider's watcher
     * has invalidated the registry's cached collection. The read issued right
     * after a toggle therefore usually lands inside that window. These two numbers
     * bound it: re-read until the catalog confirms the restore, and stop claiming
     * it once the budget is spent, so a name the host cannot restore — a
     * project-level skill, a target path something else took, or a catalog
     * anchored to another workspace — cannot leave a row behind for ever.
     */
    const RESTORE_BUDGET_MS = 6000
    const RESTORE_READ_DELAY_MS = 400

    /**
     * How many lines of a SKILL.md the detail view reads per page.
     *
     * `workspaceFiles/read` pages by lines on purpose (S-3 measured it); this is
     * the page size the panel asks for, and `eof` says whether the file was
     * longer.
     */
    const DETAIL_PAGE_LINES = 40

    /**
     * How often a `settings/conflict` is retried before the write gives up.
     *
     * The host's snapshot writes share this namespace, so conflicts are now a
     * routine event rather than an exotic one — but a loop that answers a
     * permanent conflict by writing in a circle is worse than an error the user
     * can see and retry.
     */
    const MAX_CONFLICT_RETRIES = 2

    /**
     * The Skills panel.
     *
     * Reads the catalog through `skills/list`, which is per-session (the host
     * collects skills per working directory), so it anchors to the most recently
     * updated real session. The disable list lives in this plugin's settings
     * namespace; the host half turns each disabled name into a shadow skill.
     *
     * @param props - slot props; `t` is the bound dictionary.
     * @returns the panel element.
     */
    function SkillsPanel({ t }) {
      const remote = SkillsPanel.remote
      const [saving, setSaving] = useState(false)
      const [writeError, setWriteError] = useState(undefined)
      /**
       * The list the user has asked for but that a reload has not confirmed yet.
       * Whole-array writes make the persisted value a single field, so a second
       * toggle computed from pre-write data would silently drop the first one.
       */
      const [draft, setDraft] = useState(undefined)
      /**
       * Skills switched back on that the catalog has not reported again yet.
       *
       * A row is derived from the catalog plus the persisted disable list, and
       * those two carry a name at different times. Switching a skill off leaves it
       * in the disable list, so its row survives while its directory is parked;
       * switching it back on removes it from that list at once, and the catalog
       * cannot show it again until the host half has restored the directory. In
       * that window the name is in neither source, so a row derived from them
       * alone vanishes — the defect these entries hold the row against. Each entry
       * records when the restore was asked for and is marked `expired` once the
       * budget runs out: the row then stays, labelled as unconfirmed, until the
       * catalog reports the name or the user refreshes.
       */
      const [holding, setHolding] = useState(NONE)
      /**
       * Names listed as switched off that the catalogue still offers.
       *
       * A disable lands in the settings document at once, while what actually
       * removes the row from the catalogue — the host parking the directory —
       * follows. When the host could not do it (a directory it cannot address, a
       * refused move, a crash, a stale profile), the row used to render a plain
       * unchecked switch reading "switched off", with nothing to say it had not
       * happened. Same budget as a restore, same honesty.
       */
      const [unconfirmed, setUnconfirmed] = useState(NONE)
      /** Forces the reconciliation effect to re-evaluate when its timer fires. */
      const [restoreTick, setRestoreTick] = useState(0)
      /**
       * Settings writes that have completed. A reload that started before one
       * cannot speak for it, so its answer must not replace the user's newer
       * intent: that is the difference between a switch that settles on what the
       * user chose and one that bounces back for a round-trip.
       */
      const writes = useRef(0)

      /**
       * Settings writes outstanding right now.
       *
       * A read that lands while one is in flight cannot speak for it — the host has
       * not applied it yet — so the reload a user presses mid-write used to hand the
       * switch back to the server's pre-write value for the rest of the round-trip.
       */
      const writing = useRef(0)

      const request = useAsyncData(
        useCallback(async () => {
          // Stamped before any read. Writes are counted as they complete, so
          // whatever this load reports is at least as new as the writes below it.
          const generation = writes.current
          const [settingsResult, sessionResult] = await Promise.all([
            remote.settings.describe(),
            remote.session.list({}),
          ])

          if (!settingsResult.ok) {
            throw new Error(
              `settings/describe: ${settingsResult.error.code}: ${settingsResult.error.message}`,
            )
          }

          // `ns` is the profile entry id. Prefer the documented one, but accept
          // any single namespace that actually carries `disabledSkills`, so a
          // renamed entry keeps working instead of every skill silently
          // reporting itself as enabled.
          const namespaces = settingsResult.value.namespaces ?? []
          const row =
            namespaces.find((item) => item.ns === SETTINGS_NS) ??
            namespaces.find((item) => Array.isArray(item.value?.disabledSkills)) ??
            namespaces.find((item) => JSON.stringify(item.schema ?? '').includes('disabledSkills'))
          const raw = row?.value?.disabledSkills
          const disabledList = Array.isArray(raw) ? raw : []

          let catalog = NONE
          let session
          let catalogError

          if (!sessionResult.ok) {
            catalogError = `${sessionResult.error.code}: ${sessionResult.error.message}`
          } else {
            // Skills are collected per working directory, so anchor to the newest
            // real session — and among those to one that actually has a
            // workspace, because a session without `cwd` cannot describe a
            // catalog.
            //
            // `session/list` needs no paging: the host returns the whole visible
            // set already ordered by `updatedAt` descending (see doc §9.3).
            const candidates = sessionResult.value.items
              .filter((item) => item.blank !== true && item.origin !== 'subagent')
              .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
            session =
              candidates.find((item) => typeof item.cwd === 'string' && item.cwd.length > 0) ??
              candidates[0]
            if (session === undefined) {
              catalogError = t('skills.noSession')
            } else {
              const skillsResult = await remote.skills.list({ sessionId: session.sessionId })
              if (skillsResult.ok) catalog = skillsResult.value.skills ?? NONE
              else catalogError = `${skillsResult.error.code}: ${skillsResult.error.message}`
            }
          }

          return {
            ns: row?.ns,
            revision: row?.revision,
            disabled: disabledList,
            catalog,
            session,
            catalogError,
            generation,
          }
        }, [remote, t]),
      )

      const namespace = request.data?.ns
      const serverDisabled = request.data?.disabled
      const generation = request.data?.generation
      const disabled = draft ?? serverDisabled ?? NONE
      const catalog = request.data?.catalog ?? NONE
      const session = request.data?.session

      /**
       * The list the panel currently draws, readable from inside the settings
       * subscription without re-subscribing on every render.
       */
      const disabledNow = useRef(NONE)
      disabledNow.current = disabled

      // A load that actually reports a list is authoritative — for the writes that
      // had already completed when it started. A reload still in flight when the
      // user toggles again answers with the pre-toggle value, and adopting it
      // would revert their choice for one round-trip. A failed load reports
      // nothing at all, and then keeping the draft is what stops the panel from
      // claiming the write was reverted.
      useEffect(() => {
        if (serverDisabled === undefined) return
        // A write that is still outstanding has not been applied by the host yet, so
        // no read can speak for it; and a write that landed after this read started
        // is newer than this read's answer.
        if (writing.current > 0) return
        if (generation !== undefined && generation < writes.current) return
        setDraft(undefined)
      }, [serverDisabled, generation])

      /**
       * Hold one name until the catalog reports it again.
       * @param name - the skill that was switched on.
       */
      const hold = useCallback((name) => {
        setHolding((prev) => [
          ...prev.filter((entry) => entry.name !== name),
          { name, at: Date.now(), expired: false },
        ])
      }, [])

      /**
       * Stop holding one name: the user switched it back off, or the write failed.
       * @param name - the skill whose claim is dropped.
       */
      const release = useCallback((name) => {
        setHolding((prev) => prev.filter((entry) => entry.name !== name))
      }, [])

      // Reconcile what the panel holds with what the catalog now reports.
      //
      // The catalog is the only witness that the host half finished, so a read
      // that lands before that is simply followed by another one: the row
      // converges on its own instead of needing the refresh button. The compare is
      // element-wise and the entry objects are reused, so an unchanged list never
      // schedules a re-render of its own.
      useEffect(() => {
        if (holding.length === 0) return undefined
        const present = new Set(catalog.map((skill) => skill.name))
        const deadline = Date.now() - RESTORE_BUDGET_MS
        const next = holding
          // The catalog reporting the name is the confirmation this waited for,
          // and the persisted list claiming it again means the user switched it
          // off once more, so neither case needs the claim any longer.
          .filter((entry) => !present.has(entry.name) && !disabled.includes(entry.name))
          .map((entry) => (entry.expired || entry.at > deadline ? entry : { ...entry, expired: true }))
        const changed =
          next.length !== holding.length || next.some((entry, index) => entry !== holding[index])
        if (changed) {
          setHolding(next)
          return undefined
        }
        // Nothing is waiting on the host any more: the rows stay until the catalog
        // or the user settles them, so stop re-reading.
        if (next.every((entry) => entry.expired)) return undefined
        const timer = setTimeout(() => {
          request.reload()
          setRestoreTick((tick) => tick + 1)
        }, RESTORE_READ_DELAY_MS)
        return () => clearTimeout(timer)
        // `request.reload` only bumps a state counter, and the tick below is the
        // trigger that comes back around; the request object itself is rebuilt on
        // every render and must not become a dependency.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [catalog, disabled, holding, restoreTick])

      // The disable direction's half of the same reconciliation. A name that is
      // listed as off, is still offered by the catalogue, and has been that way for
      // the whole budget means the host did not do the move — so the settled claim
      // is withdrawn and the panel says so, instead of rendering a plain "switched
      // off" that is not true.
      useEffect(() => {
        const present = new Set(catalog.map((skill) => skill.name))
        const deadline = Date.now() - RESTORE_BUDGET_MS
        const next = disabled
          .filter((name) => present.has(name))
          .map((name) => unconfirmed.find((entry) => entry.name === name) ?? { name, at: Date.now() })
          .map((entry) => (entry.expired || entry.at <= deadline ? { ...entry, expired: true } : entry))
        const changed =
          next.length !== unconfirmed.length ||
          next.some(
            (entry, index) =>
              entry.name !== unconfirmed[index]?.name || entry.expired !== unconfirmed[index]?.expired,
          )
        if (changed) {
          setUnconfirmed(next)
          return undefined
        }
        if (next.length === 0 || next.every((entry) => entry.expired)) return undefined
        const timer = setTimeout(() => {
          request.reload()
          setRestoreTick((tick) => tick + 1)
        }, RESTORE_READ_DELAY_MS)
        return () => clearTimeout(timer)
        // `request.reload` only bumps a state counter, and the tick above is the
        // trigger that comes back around; the request object itself is rebuilt on
        // every render and must not become a dependency.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [catalog, disabled, unconfirmed, restoreTick])

      /**
       * Re-read the catalog, settling the rows whose restore the host never
       * confirmed. The panel's one refresh button uses it: a refresh is the user
       * saying "believe what the catalog says now".
       */
      const reloadCatalog = useCallback(() => {
        setHolding((prev) => prev.filter((entry) => !entry.expired))
        request.reload()
      }, [request])

      /** Which row's detail is open, and what its read produced (S-3, B2c). */
      const [detailName, setDetailName] = useState(undefined)
      const [detail, setDetail] = useState(undefined)
      /** The row filter; it only narrows what is drawn. */
      const [query, setQuery] = useState('')

      /**
       * Open one skill's detail: the fields the catalog carried, plus the first
       * page of its SKILL.md.
       *
       * The read goes through `remote.workspaceFiles.read(sessionId, path,
       * { limit })` — the S-3 measurement's answer (`tools/m7-spike.mjs` phase
       * F): the shipped remote table already exposes it, it pages by lines, and
       * it reads a path outside the session's workspace too (which is where user
       * skills live). A skill the catalog gave no `path` for cannot be read at
       * all, and the panel says that instead of showing an empty box.
       *
       * @param row - the row whose detail was asked for.
       */
      const openDetail = useCallback(
        async (row) => {
          if (detailName === row.name) {
            setDetailName(undefined)
            setDetail(undefined)
            return
          }
          setDetailName(row.name)
          setDetail(undefined)
          if (typeof row.path !== 'string' || row.path === '') return
          const files = remote.workspaceFiles
          if (files === undefined || typeof files.read !== 'function') {
            setDetail({ status: 'error', error: t('skills.detail.noFileApi') })
            return
          }
          const sessionId = session?.sessionId
          if (sessionId === undefined) {
            setDetail({ status: 'error', error: t('skills.noSession') })
            return
          }
          setDetail({ status: 'loading' })
          try {
            const result = await files.read(sessionId, row.path, { limit: DETAIL_PAGE_LINES })
            if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
            setDetail({
              status: 'ready',
              text: typeof result.value?.text === 'string' ? result.value.text : '',
              lines:
                typeof result.value?.lines === 'number' ? result.value.lines : DETAIL_PAGE_LINES,
              eof: result.value?.eof !== false,
            })
          } catch (error) {
            setDetail({ status: 'error', error: String(error?.message ?? error) })
          }
        },
        [detailName, remote, session, t],
      )

      // The same document is reachable from the built-in settings surface, so
      // re-read when it changes. Guarded: a host without forwarded remote events
      // simply keeps the refresh button as the only way to re-read.
      useEffect(() => {
        if (typeof remote.$on !== 'function') return undefined
        return remote.$on('settings/document-updated', (changed) => {
          if (typeof changed === 'string' && namespace !== undefined && changed !== namespace) return
          // The event names the namespace, not the field — and the MCP snapshot
          // lives in this same namespace now. One describe tells whether the
          // list this panel draws actually moved; reloading the catalog
          // (describe + session.list + skills.list) for every snapshot write was
          // the storm the namespace guard alone could not stop (N14).
          void (async () => {
            try {
              const fresh = await remote.settings.describe()
              const row = fresh.ok
                ? (fresh.value.namespaces ?? []).find((item) => item.ns === namespace)
                : undefined
              const latest = Array.isArray(row?.value?.disabledSkills)
                ? row.value.disabledSkills
                : undefined
              if (latest !== undefined &&
                JSON.stringify(latest) === JSON.stringify(disabledNow.current)) {
                return
              }
            } catch {
              // Fall through: the full reload is the safe answer when the probe
              // itself fails.
            }
            request.reload()
          })()
        })
        // `request.reload` only bumps a state counter, so the subscription does
        // not need to be rebuilt when the request object is recreated.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [remote, namespace])

      const setDisabled = useCallback(
        async (next, intent) => {
          if (namespace === undefined) {
            setWriteError(t('skills.noNamespace'))
            return
          }
          setSaving(true)
          writing.current += 1
          setWriteError(undefined)
          setDraft(next)
          // Recorded with the optimistic state, so the row is never missing from
          // the list for even one frame. A refused write takes it back below.
          if (intent.enabled) hold(intent.name)
          else release(intent.name)
          let ops = [{ op: 'set', path: ['disabledSkills'], value: next }]
          try {
            // Write against the revision we read. A concurrent writer makes the
            // host refuse with `settings/conflict`; re-read and try again so a
            // race costs a retry instead of a lost change. The loop is bounded
            // because the host's snapshot writes share this namespace and make
            // conflicts routine (N12) — and because an unbounded loop answering
            // a permanent conflict would be a write storm, not a retry.
            let result = await remote.settings.mutate(namespace, ops, request.data?.revision)
            for (let retries = 0; retries < MAX_CONFLICT_RETRIES; retries += 1) {
              if (result.ok || result.error?.code !== 'settings/conflict') break
              const fresh = await remote.settings.describe()
              const row = fresh.ok
                ? (fresh.value.namespaces ?? []).find((item) => item.ns === namespace)
                : undefined
              if (row === undefined) break
              // Re-apply *this* intent on top of the list the other writer left,
              // instead of re-sending the array computed before the conflict. The
              // fresh read used to be taken and then thrown away, so a second
              // window's change was silently overwritten by a write that went on
              // to report success.
              const latest = Array.isArray(row.value?.disabledSkills)
                ? row.value.disabledSkills
                : undefined
              if (latest === undefined) break
              ops = [{
                op: 'set',
                path: ['disabledSkills'],
                value: intent.enabled
                  ? latest.filter((name) => name !== intent.name).sort()
                  : [...new Set([...latest, intent.name])].sort(),
              }]
              result = await remote.settings.mutate(namespace, ops, row.revision)
            }
            if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
            // The reply is the namespace's new view; adopt it rather than trusting
            // the request, then reload for the catalog the write may have changed.
            const confirmed = result.value?.value?.disabledSkills
            setDraft(Array.isArray(confirmed) ? confirmed : next)
            // Counted before the reload is asked for, so every read that starts
            // from here on knows it may speak for this write.
            writes.current += 1
            request.reload()
            // Automatic on purpose: the built-in `/` menu caches one catalog per
            // conversation and clears it only on a connection reset, so without
            // this the toggle stays invisible there until a page reload. The emit
            // is guarded — a host without the client event bus simply skips it.
            SkillsPanel.refreshConnectedCaches?.()
          } catch (error) {
            // Put the claim back where the write left it. A failed enable had
            // its hold dropped at intent time; a failed *disable* has to re-take
            // the hold it dropped — the skill is still enabled on the server,
            // and without the hold the row had no source left (not the server
            // list, not the catalog, not the hold) and silently disappeared.
            setDraft(undefined)
            if (intent.enabled) release(intent.name)
            else hold(intent.name)
            setWriteError(String(error?.message ?? error))
            console.error('[dsh-panel-skills] settings.mutate failed:', error)
          } finally {
            writing.current -= 1
            setSaving(false)
          }
        },
        [remote, request, namespace, t, hold, release],
      )

      // Catalog skills first, then every name the catalog no longer reports: a
      // disabled skill whose directory is parked out of the scanned roots, and a
      // skill the host has not finished restoring.
      const rows = useMemo(() => {
        const seen = new Set()
        const out = []
        for (const skill of catalog) {
          if (seen.has(skill.name)) continue
          seen.add(skill.name)
          out.push({
            name: skill.name,
            description: skill.description,
            path: skill.path,
            whenToUse: skill.whenToUse,
            modelInvocable: skill.modelInvocable,
          })
        }
        for (const name of disabled) {
          if (seen.has(name)) continue
          // The host filters `disabledSkills` to the skill-name grammar before an
          // entry can reach a candidate — one bad name rejects the whole catalog
          // collection — so a row here for a name outside that grammar would claim
          // a switch-off the host will never carry out.
          if (typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) continue
          seen.add(name)
          out.push({ name, description: undefined, path: undefined })
        }
        for (const entry of holding) {
          if (seen.has(entry.name)) continue
          seen.add(entry.name)
          out.push({ name: entry.name, description: undefined, path: undefined, pending: entry })
        }
        return out.sort((a, b) => a.name.localeCompare(b.name))
      }, [catalog, disabled, holding])

      const scopeText = session?.cwd ?? session?.sessionId ?? t('skills.noSession')
      /** Names whose switch-off the host never confirmed. */
      const unconfirmedOff = new Set(
        unconfirmed.filter((entry) => entry.expired).map((entry) => entry.name),
      )
      // The filter narrows the drawn rows only: `holding`/`unconfirmed` keep
      // working off the full list, because they track the host, not the view.
      const needle = query.trim().toLowerCase()
      const filterTextOf = (row) =>
        [row.name, row.description, row.whenToUse].filter(Boolean).join(' ').toLowerCase()
      const visibleRows = needle === '' ? rows : rows.filter((row) => filterTextOf(row).includes(needle))

      /**
       * One skill's detail block.
       *
       * Everything shown comes from a named source: the catalog fields it
       * actually carried, or a line-paged read of the SKILL.md the catalog named.
       * A missing path, a missing read surface and a refused read are three
       * different sentences — never an empty box that pretends the file was
       * empty.
       *
       * @param row - the row whose detail was opened.
       * @returns the detail element.
       */
      const renderSkillDetail = (row) => {
        const state = detail
        const field = (label, value) =>
          value === undefined || value === '' || value === null
            ? null
            : jsxs('div', {
                style: { display: 'flex', gap: '8px', alignItems: 'baseline' },
                children: [
                  jsx('span', { style: fieldLabelStyle, children: label }),
                  jsx('span', { style: { fontSize: '12px', wordBreak: 'break-all' }, children: String(value) }),
                ],
              })
        return jsxs('div', {
          style: formStyle,
          children: [
            field(t('skills.detail.description'), row.description),
            field(t('skills.detail.whenToUse'), row.whenToUse),
            field(
              t('skills.detail.modelInvocable'),
              typeof row.modelInvocable === 'boolean' ? String(row.modelInvocable) : undefined,
            ),
            field(t('skills.detail.path'), row.path),
            typeof row.path !== 'string' || row.path === ''
              ? jsx('p', { style: subtitleStyle, children: t('skills.detail.noPath') })
              : state?.status === 'loading'
                ? jsx('p', { style: subtitleStyle, children: t('skills.detail.loading') })
                : state?.status === 'error'
                  ? jsx(ErrorLine, {
                      message: `${t('skills.detail.error')}: ${String(state.error)}`,
                    })
                  : state?.status === 'ready'
                    ? jsxs('div', {
                        style: { display: 'grid', gap: '4px' },
                        children: [
                          jsx('textarea', {
                            readOnly: true,
                            rows: 10,
                            value: state.text === '' ? t('skills.detail.empty') : state.text,
                            'aria-label': t('skills.detail'),
                            style: snippetStyle,
                          }),
                          jsx('span', {
                            style: fieldLabelStyle,
                            children: `${t('skills.detail.lines').replace('{n}', String(state.lines ?? 0))}${
                              state.eof === true
                                ? ''
                                : ` ${t('skills.detail.more').replace('{n}', String(state.lines ?? 0))}`
                            }`,
                          }),
                        ],
                      })
                    : null,
          ],
        })
      }

      return jsxs('div', {
        style: pageStyle,
        children: [
          jsxs('div', {
            style: headerStyle,
            children: [
              jsx('h1', { style: titleStyle, children: t('skills.title') }),
              jsx('span', { style: { flex: 1 } }),
              jsx(TextButton, {
                label: t('skills.refresh'),
                title: t('skills.refreshHint'),
                // One click covers both kinds of staleness. The panel's reads are
                // its own; the built-in `/` menu caches one catalog per
                // conversation and drops it only on a connection reset, so the
                // refresh doubles as that fallback — the same broadcast a
                // successful toggle already sends.
                onClick: () => {
                  SkillsPanel.refreshConnectedCaches?.()
                  reloadCatalog()
                },
                disabled: request.status === 'loading',
              }),
            ],
          }),
          jsx('p', {
            style: subtitleStyle,
            children: `${t('skills.subtitle')} — ${scopeText}`,
          }),

          request.status === 'loading' && rows.length === 0
            ? jsx('p', { style: subtitleStyle, children: t('common.loading') })
            : null,
          request.status === 'error'
            ? jsx('p', {
                style: subtitleStyle,
                children: `${t('common.error')}: ${String(request.error)}`,
              })
            : null,
          request.data?.catalogError
            ? jsx('p', { style: subtitleStyle, children: request.data.catalogError })
            : null,
          holding.some((entry) => entry.expired)
            ? jsx('p', { style: subtitleStyle, children: t('skills.unconfirmed.restoreHint') })
            : null,
          unconfirmedOff.size > 0
            ? jsx('p', { style: subtitleStyle, children: t('skills.unconfirmed.offHint') })
            : null,
          request.status === 'ready' && namespace === undefined
            ? jsx(ErrorLine, { message: t('skills.noNamespace') })
            : null,
          jsx(ErrorLine, {
            message: writeError === undefined ? undefined : `${t('common.error')}: ${writeError}`,
          }),
          request.status === 'ready' && rows.length === 0
            ? jsx('p', { style: subtitleStyle, children: t('skills.empty') })
            : null,
          request.status === 'ready' && rows.length > 0
            ? jsx(FilterBox, {
                value: query,
                onChange: setQuery,
                label: t('common.filterPlaceholder'),
                clearLabel: t('common.filterClear'),
              })
            : null,
          request.status === 'ready' && visibleRows.length === 0 && rows.length > 0
            ? jsx('p', {
                style: subtitleStyle,
                children: t('skills.search.none').replace('{q}', query.trim()),
              })
            : null,

          visibleRows.map((row) => {
            const off = disabled.includes(row.name)
            const pending = row.pending
            const leftover = unconfirmedOff.has(row.name)
            const detailOpen = detailName === row.name
            const detailButton = jsx(ActionButton, {
              label: detailOpen ? t('skills.detail.close') : t('skills.detail'),
              ariaLabel: `${t('skills.detail')}: ${row.name}`,
              onClick: () => void openDetail(row),
            })
            return jsxs(
              'div',
              {
                children: [
                  jsx(StatusRow, {
                    // Until the catalog reports the skill again the panel only knows
                    // that it asked for it, so the dot stays in flight rather than
                    // claiming the row is settled. The same goes for a switch-off the
                    // host never carried out: the row is offered again while the list
                    // says it is off, and only the dot says which of the two is stale.
                    dotState:
                      pending === undefined
                        ? off
                          ? leftover
                            ? 'warning'
                            : 'idle'
                          : 'done'
                        : pending.expired
                          ? 'warning'
                          : 'ongoing',
                    title: row.name,
                    meta: [
                      off ? t('skills.disabled') : t('skills.enabled'),
                      pending === undefined
                        ? leftover
                          ? t('skills.unconfirmed')
                          : undefined
                        : pending.expired
                          ? t('skills.unconfirmed')
                          : t('skills.restoring'),
                      row.description,
                      row.path,
                    ]
                      .filter(Boolean)
                      .join(' · '),
                    control: jsxs('div', {
                      style: { display: 'flex', alignItems: 'center', gap: '6px' },
                      children: [
                        detailButton,
                        jsx(Switch, {
                          checked: !off,
                          // Every row shares one persisted array, so a write in flight
                          // locks the whole list rather than just its own row.
                          disabled: saving,
                          title: off ? t('skills.enabled') : t('skills.disabled'),
                          label: row.name,
                          onChange: (next) =>
                            setDisabled(
                              // Both directions keep the persisted array canonical, so a
                              // toggle that changes nothing else changes nothing on disk.
                              next
                                ? disabled.filter((item) => item !== row.name).sort()
                                : [...disabled, row.name].sort(),
                              { name: row.name, enabled: next },
                            ),
                        }),
                      ],
                    }),
                  }),
                  detailOpen ? renderSkillDetail(row) : null,
                ],
              },
              row.name,
            )
          }),

          jsx('p', { style: caveatStyle, children: t('skills.caveat') }),
          disabled.length > 0
            ? jsx('p', {
                style: subtitleStyle,
                children: t('uninstall.panelHint').replace('{n}', String(disabled.length)),
              })
            : null,
        ],
      })
    }
    /** How long a preparation may take before the panel calls it unconfirmed. */
    const UNINSTALL_BUDGET_MS = 15_000

    /**
     * The safe-uninstall preparation and removal, shared by every entry point.
     *
     * The parked skill directories are the only thing an uninstall can lose, and
     * this package is the only code that can put them back. The host restores
     * every owned directory first and answers `ready`; only then does this hook
     * call the manager. A refusal leaves the bundle installed and every
     * directory where it is. The panel used to own this outright; the plugin
     * detail page now offers the same control next to the official uninstall
     * button, so the state machine lives here and each presentation decides
     * where to draw it.
     *
     * @param remote - the client remote table.
     * @param t - the bound dictionary.
     * @returns the preparation state and the actions a presentation calls.
     */
    function useSafeUninstall(remote, t) {
      const [confirming, setConfirming] = useState(false)
      const [phase, setPhase] = useState(undefined)
      const [nonce, setNonce] = useState(undefined)
      const [error, setError] = useState(undefined)
      const [notice, setNotice] = useState(undefined)
      const busy = phase !== undefined

      const request = useAsyncData(
        useCallback(async () => {
          // The host half's own Loader phase is the one fact that says whether
          // a preparation can be answered at all; a disabled bundle still has a
          // removable row, but nothing would hear the request.
          const inventory = await remote.pluginInventory.list()
          const self = inventory.ok
            ? inventory.value.entries.find((entry) => entry.moduleName === SELF_MODULE)
            : undefined

          let bundle
          let bundleError
          try {
            const listed = await remote.pluginManager.listBundles()
            if (listed.ok) {
              bundle = (listed.value ?? []).find((item) => item?.name === SELF_MODULE)
            } else {
              bundleError = `${listed.error.code}: ${listed.error.message}`
            }
          } catch (failure) {
            bundleError = String(failure?.message ?? failure)
          }

          let ns
          let revision
          let uninstallResult
          let disabled = NONE
          try {
            const described = await remote.settings.describe()
            if (!described.ok) throw new Error(`${described.error.code}: ${described.error.message}`)
            const row = (described.value.namespaces ?? []).find((item) => item.ns === SETTINGS_NS)
            ns = row?.ns
            revision = row?.revision
            uninstallResult = row?.value?.safeUninstallResult
            disabled = Array.isArray(row?.value?.disabledSkills) ? row.value.disabledSkills : NONE
          } catch (failure) {
            bundleError ??= String(failure?.message ?? failure)
          }

          return {
            selfPhase: self === undefined ? undefined : String(self.fiberPhase),
            bundle,
            bundleError,
            ns,
            revision,
            uninstallResult,
            disabled,
          }
        }, [remote]),
      )

      const ns = request.data?.ns
      const hostRunning = request.data?.selfPhase === 'active'

      /**
       * Ask the host to put every parked skill back. The request travels through
       * this plugin's own settings namespace, the same write path the switches use.
       */
      const requestUninstall = useCallback(async () => {
        if (phase !== undefined) return
        if (ns === undefined) {
          setError(t('skills.noNamespace'))
          return
        }
        const next = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
        setConfirming(false)
        setError(undefined)
        setNotice(undefined)
        setNonce(next)
        setPhase('preparing')
        const ops = [{
          op: 'set',
          path: ['safeUninstallRequest'],
          value: { nonce: next, at: new Date().toISOString() },
        }]
        try {
          let result = await remote.settings.mutate(ns, ops, request.data?.revision)
          for (let retries = 0; retries < MAX_CONFLICT_RETRIES; retries += 1) {
            if (result.ok || result.error?.code !== 'settings/conflict') break
            const fresh = await remote.settings.describe()
            const row = fresh.ok
              ? (fresh.value.namespaces ?? []).find((item) => item.ns === ns)
              : undefined
            if (row === undefined) break
            result = await remote.settings.mutate(ns, ops, row.revision)
          }
          if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
          request.reload()
        } catch (failure) {
          setPhase(undefined)
          setNonce(undefined)
          setError(String(failure?.message ?? failure))
          console.error('[dsh-panel-skills] safe-uninstall request failed:', failure)
        }
      }, [remote, request, ns, t, phase])

      // The host's preparation outcome. Only a `ready` answer proceeds to the
      // manager; every other code is a refusal and leaves the bundle installed.
      useEffect(() => {
        const result = request.data?.uninstallResult
        if (nonce === undefined || result === undefined || result.nonce !== nonce) return
        if (phase !== 'preparing') return
        if (result.ok !== true || result.code !== 'ready') {
          const keyed = t('uninstall.code.' + String(result.code ?? 'unknown'))
          const label = typeof keyed === 'string' ? keyed : String(result.code ?? '')
          setPhase(undefined)
          setNonce(undefined)
          // The host's sentence carries the paths that block the restore — the one
          // detail a person needs to fix the filesystem — so it is shown, not
          // reduced to the class alone. It is a fixed sentence built by this
          // plugin's own host half; no configuration value is quoted.
          setError(`${label}: ${String(result.message ?? '')}`)
          request.reload()
          return
        }
        setPhase('removing')
        const remove = async () => {
          try {
            const removed = await remote.pluginManager.removeBundle(SELF_MODULE)
            if (!removed.ok) throw new Error(`${removed.error?.code}: ${removed.error?.message}`)
            const value = removed.value ?? {}
            if (value.application !== 'applied') {
              const code = String(value.error?.code ?? 'remove-failed')
              if (code === 'bundle-in-use') {
                // S-4d measured that the failed removal has already deselected
                // the bundle. Put the selection back rather than leave the user
                // with a plugin that is installed but switched off.
                try {
                  await remote.pluginManager.setBundleEnabled(SELF_MODULE, true)
                } catch (failure) {
                  console.error('[dsh-panel-skills] re-enabling after bundle-in-use failed:', failure)
                }
              }
              const keyed = t('uninstall.code.' + code)
              throw new Error(typeof keyed === 'string' ? keyed : code)
            }
            setPhase(undefined)
            setNonce(undefined)
            setError(undefined)
            setNotice(t('uninstall.done'))
            request.reload()
          } catch (failure) {
            setPhase(undefined)
            setNonce(undefined)
            setError(String(failure?.message ?? failure))
            request.reload()
          }
        }
        remove()
        // The request object is rebuilt every render; only the result and the
        // panel's own phase/nonce decide whether this runs.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [request.data?.uninstallResult, nonce, phase, remote, t])

      // A host that never answers must not leave the panel claiming a
      // preparation is on its way for ever.
      useEffect(() => {
        if (phase !== 'preparing') return undefined
        const timer = setTimeout(() => {
          setPhase(undefined)
          setNonce(undefined)
          setError(t('uninstall.unconfirmed'))
        }, UNINSTALL_BUDGET_MS)
        return () => clearTimeout(timer)
      }, [phase, t])

      // The result is pushed into this namespace by the host; without the event
      // the panel would wait for the budget even when the answer is already there.
      useEffect(() => {
        if (typeof remote.$on !== 'function') return undefined
        return remote.$on('settings/document-updated', (changed) => {
          if (typeof changed === 'string' && ns !== undefined && changed !== ns) return
          request.reload()
        })
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [remote, ns])

      return {
        request,
        hostRunning,
        phase,
        error,
        notice,
        confirming,
        setConfirming,
        requestUninstall,
        busy,
      }
    }

    /**
     * The safe-uninstall control on this plugin's own detail page.
     *
     * The page's own uninstall button cannot be replaced or hidden; this sits
     * beside it, and only for this bundle and only while there is something to
     * restore. Without a switched-off skill the official button is already safe,
     * so a second button would be noise.
     *
     * @param props - the slot's subject plus the remote table and dictionary.
     * @returns the control, or null for every other plugin and an idle page.
     */
    function SafeUninstallAction({ subject, remote, t }) {
      if (subject?.kind !== 'bundle' || subject.pkg?.name !== SELF_MODULE) return null
      return jsx(SafeUninstallActionBody, { remote, t })
    }

    /**
     * The stateful half, mounted only for this bundle's page.
     *
     * The official page keeps its own uninstall button; this is the path that
     * refuses *before* the package disappears, which the manager's removal
     * cannot do for a plugin. A disabled bundle never reaches this component —
     * its client half is unloaded — so the button is offered exactly while a
     * preparation can still be answered.
     *
     * @param props - the remote table and dictionary.
     * @returns the button, its confirmation, or a compact status line.
     */
    function SafeUninstallActionBody({ remote, t }) {
      const {
        request,
        hostRunning,
        phase,
        error,
        notice,
        confirming,
        setConfirming,
        requestUninstall,
        busy,
      } = useSafeUninstall(remote, t)

      if (request.status !== 'ready') return null
      const data = request.data
      // The manager's own list is the only evidence that this is a removable
      // profile bundle; without it there is nothing a preparation could remove.
      if (data.bundleError !== undefined) return null
      const bundle = data.bundle
      if (bundle?.installed !== true || bundle?.enabled !== true || bundle?.removable !== true) {
        return null
      }
      const disabled = Array.isArray(data.disabled) ? data.disabled : NONE
      // Nothing is switched off: the official button is already a safe uninstall,
      // so do not compete with it.
      if (disabled.length === 0) return null

      const note = (text) => jsx('span', { style: actionNoteStyle, children: text })
      if (notice !== undefined) return note(notice)
      if (phase === 'preparing') return note(t('uninstall.preparing'))
      if (phase === 'removing') return note(t('uninstall.removing'))
      // Before the refusal branch: retrying after a refusal must reach the
      // confirmation, and the error stays in state for the cancel path.
      if (confirming) {
        return jsxs('span', {
          style: { display: 'inline-flex', alignItems: 'center', gap: '6px' },
          children: [
            jsx(ActionButton, {
              label: t('uninstall.confirm'),
              onClick: requestUninstall,
              disabled: busy || !hostRunning,
            }),
            jsx(ActionButton, {
              label: t('uninstall.cancel'),
              onClick: () => setConfirming(false),
              disabled: busy,
            }),
            hostRunning
              ? null
              : jsx('span', { style: actionNoteStyle, children: t('uninstall.hostDown') }),
          ],
        })
      }
      if (error !== undefined) {
        // A refusal must leave a way to try again after the filesystem is
        // fixed; replacing the button with the error alone would strand the
        // page until a reload. The full sentence (with the blocking paths)
        // stays in the tooltip because the actions row is 16px-gapped.
        return jsxs('span', {
          style: { display: 'inline-flex', alignItems: 'center', gap: '6px' },
          children: [
            jsx('span', {
              style: { ...actionNoteStyle, color: '#e5534b' },
              title: error,
              tabIndex: 0,
              'aria-label': error,
              children: t('uninstall.refusedShort'),
            }),
            jsx(ActionButton, {
              label: t('uninstall.retry'),
              title: error,
              onClick: () => setConfirming(true),
              disabled: busy || !hostRunning,
            }),
          ],
        })
      }
      return jsx(ActionButton, {
        label: t('uninstall.pageAction').replace('{n}', String(disabled.length)),
        // The full explanation is the section the panel used to show. It stays
        // available on hover/focus without taking a row in the page header.
        title: hostRunning ? t('uninstall.body') : t('uninstall.hostDown'),
        onClick: () => setConfirming(true),
        disabled: busy || !hostRunning,
      })
    }

    // ----------------------------------------------------------------- apply

    /**
     * Contribute the Skills entry to the sidebar, bind the dictionary, and hand
     * the panel the remotes it needs.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-panel-skills: dictionaries')
      const t = ctx.locale.bind(NS)

      // The panel components are registered as slot occupants, not rendered by
      // `apply`, so they cannot close over `ctx`. Hand them the remotes they need.
      SkillsPanel.remote = ctx.remote
      /**
       * Ask the client to re-fetch what it cached for this connection.
       *
       * The built-in `/` skill menu caches one catalog per conversation and clears
       * it only on an agent-preset change or a connection reset, so a toggle would
       * otherwise need a page reload before it shows there. A reset is a
       * broadcast — about twenty shipped modules refresh their own stores on it,
       * which is what a reconnect does — so it stays a deliberate user action
       * rather than something a settings write fires behind their back.
       */
      SkillsPanel.refreshConnectedCaches = () => {
        try {
          ctx.emit?.('connection/reset')
        } catch (error) {
          console.error('[dsh-panel-skills] connection/reset emit failed:', error)
        }
      }

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_SKILLS,
            order: 2,
            label: () => t('panel.skills'),
            locale: NS,
          },
          SkillsPanelIcon,
        ),
      )

      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_SKILLS, locale: NS }, SkillsPanel),
      )

      // The plugin's own detail page is where most people uninstall from, so the
      // safe path belongs there, next to the page's own uninstall button. The
      // slot is additive — the official button cannot be replaced or hidden — so
      // the control renders only for this bundle and only while a switched-off
      // skill gives it something to protect.
      const SafeUninstallSlot = (props) =>
        jsx(SafeUninstallAction, { ...props, remote: ctx.remote, t })
      ctx.slots.inject('plugins.detail.actions', () =>
        ctx.slots.register(
          {
            name: 'plugins.detail.actions',
            id: 'dsh-panel-skills-safe-uninstall',
            order: -10,
          },
          SafeUninstallSlot,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})