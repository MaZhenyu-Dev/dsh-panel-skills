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

    const { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } = react
    const { IconSkillOutlineRegular, Switch } = primitives

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
      'skills.detail.labelWidth': '68px',
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
      'common.filterPlaceholder': '按名称或者描述过滤',
      'common.filterClear': '清除过滤',
      'skills.search.none': '没有找到与“{q}”匹配的技能',
      'skills.filter.label': '状态筛选',
      'skills.filter.all': '全部',
      'skills.filter.on': '已启用',
      'skills.filter.off': '已关闭',
      'skills.meta.shown': '显示 {shown} / {total} 个技能',
      'skills.descMatch': '描述匹配',
      'skills.search.recents': '最近搜索',
      'skills.search.recentsClear': '清空',
      'skills.search.suggestions': '搜索建议',
      'skills.search.delete': '删除这条最近搜索',
      'skills.search.keySelect': '选择',
      'skills.search.keySearch': '搜索',
      'skills.search.keyComplete': '补全',
      'skills.search.keyClose': '关闭',
      'skills.copy.path': '复制路径',
      'skills.copy.file': '复制',
      'skills.copy.done': '已复制',
      'skills.copy.fileDone': '已复制 ✓',
      'skills.copy.failed': '复制失败',
      'skills.toast.refreshed': '技能目录已刷新',
      'skills.toast.enabled': '已启用「{name}」',
      'skills.toast.disabled': '已关闭「{name}」',
      'skills.toast.pathCopied': '已复制路径',
      'skills.toast.fileCopied': '已复制 SKILL.md 内容',
      'skills.empty.body': '换个关键词试试，或者清除筛选条件',
      'skills.empty.reset': '清除筛选',
      'skills.empty.status': '该状态下暂无技能',
      'skills.empty.statusBody': '切换状态，或者清除筛选条件',
      'skills.detail.file': 'SKILL.md',
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
      'skills.detail.description': 'Description',
      'skills.detail.whenToUse': 'When to use',
      'skills.detail.modelInvocable': 'Model visible',
      'skills.detail.path': 'Path',
      'skills.detail.labelWidth': '96px',
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
      'common.filterPlaceholder': 'Filter by name or description',
      'common.filterClear': 'Clear filter',
      'skills.search.none': 'No skill matches “{q}”',
      'skills.filter.label': 'Filter by status',
      'skills.filter.all': 'All',
      'skills.filter.on': 'Enabled',
      'skills.filter.off': 'Disabled',
      'skills.meta.shown': 'Showing {shown} of {total} skills',
      'skills.descMatch': 'Description match',
      'skills.search.recents': 'Recent searches',
      'skills.search.recentsClear': 'Clear',
      'skills.search.suggestions': 'Suggestions',
      'skills.search.delete': 'Remove this recent search',
      'skills.search.keySelect': 'select',
      'skills.search.keySearch': 'search',
      'skills.search.keyComplete': 'complete',
      'skills.search.keyClose': 'close',
      'skills.copy.path': 'Copy path',
      'skills.copy.file': 'Copy',
      'skills.copy.done': 'Copied',
      'skills.copy.fileDone': 'Copied ✓',
      'skills.copy.failed': 'Copy failed',
      'skills.toast.refreshed': 'Skill catalog refreshed',
      'skills.toast.enabled': 'Enabled “{name}”',
      'skills.toast.disabled': 'Disabled “{name}”',
      'skills.toast.pathCopied': 'Path copied',
      'skills.toast.fileCopied': 'SKILL.md copied',
      'skills.empty.body': 'Try another keyword, or clear the filters',
      'skills.empty.reset': 'Clear filters',
      'skills.empty.status': 'No skills in this state',
      'skills.empty.statusBody': 'Switch the status filter, or clear the filters',
      'skills.detail.file': 'SKILL.md',
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

    // ------------------------------------------------------------ panel styles

    /**
     * Every rule is scoped under `.dsh-sk`, so the panel can carry the demo's
     * typography, glass and motion without touching the host's own CSS. The
     * colour tokens fall back to the DSH aliases, so light/dark follows the
     * application instead of a second theme switch inside the panel.
     */
    const PANEL_CSS = `
      .dsh-sk {
        --sk-spring: cubic-bezier(.34, 1.56, .64, 1);
        --sk-ease: cubic-bezier(.22, 1, .36, 1);
        --sk-bg: var(--dsw-alias-bg-base, #ffffff);
        --sk-bg-fade: color-mix(in srgb, var(--sk-bg) 88%, transparent);
        --sk-text: var(--dsw-alias-label-primary, #0f1115);
        --sk-text-2: var(--dsw-alias-label-secondary, #61666b);
        --sk-text-3: var(--dsw-alias-label-tertiary, #81858c);
        --sk-line: var(--dsw-alias-border-l2, rgba(0, 0, 0, .1));
        --sk-line-strong: var(--dsw-alias-border-l3, rgba(0, 0, 0, .14));
        --sk-btn-bg: var(--dsw-alias-bg-base, #ffffff);
        --sk-btn-line: var(--dsw-alias-border-l3, rgba(0, 0, 0, .14));
        --sk-btn-hover: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, .06));
        --sk-row-hover: var(--dsw-alias-interactive-bg-hover, rgba(120, 120, 128, .06));
        --sk-green: var(--dsw-alias-state-success-primary, #22c55e);
        --sk-warn: var(--dsw-alias-state-warn-primary, #f59e0b);
        --sk-accent: var(--dsw-alias-link, #4176e6);
        --sk-mark: color-mix(in srgb, var(--sk-accent) 14%, transparent);
        --sk-glass-top: rgba(255, 255, 255, .66);
        --sk-glass-bot: rgba(247, 247, 250, .42);
        --sk-glass-ring: rgba(20, 20, 40, .09);
        --sk-glass-hi: rgba(255, 255, 255, .95);
        --sk-glass-low: rgba(20, 20, 40, .07);
        --sk-glass-shadow: 0 1px 2px rgba(16, 16, 28, .06), 0 12px 30px -14px rgba(16, 16, 28, .28);
        --sk-glass-shadow-stuck: 0 1px 2px rgba(16, 16, 28, .08), 0 18px 36px -14px rgba(16, 16, 28, .38);
        --sk-shine: rgba(255, 255, 255, .75);
        --sk-shine-strength: .6;
        --sk-pop-bg: rgba(255, 255, 255, .82);
        --sk-kbd-bg: rgba(255, 255, 255, .65);
        --sk-kbd-low: rgba(20, 20, 40, .12);
        --sk-chip-bg: rgba(120, 120, 128, .11);
        --sk-chip-hover: rgba(120, 120, 128, .18);
        --sk-seg-track: rgba(120, 120, 128, .13);
        --sk-seg-thumb-a: #ffffff;
        --sk-seg-thumb-b: #f2f2f6;
        --sk-card-bg: #ffffff;
        --sk-card-border: var(--dsw-alias-border-l2, #e3e3e8);
        --sk-card-shadow: 0 4px 18px -6px rgba(16, 16, 28, .07), 0 1px 2px rgba(16, 16, 28, .04);
        --sk-code-bg: #f8f8fa;
        --sk-code-border: #e3e3e8;
        --sk-code-text: #26262e;
        --sk-badge-bg: rgba(34, 197, 94, .1);
        --sk-badge-text: #15803d;
        color: var(--sk-text);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei UI",
          "Microsoft YaHei", "PingFang SC", "Noto Sans SC", system-ui, sans-serif;
        font-size: 14px;
        line-height: 1.4;
        -webkit-font-smoothing: antialiased;
        position: relative;
        height: 100%;
        overflow-y: auto;
        overflow-x: clip;
        box-sizing: border-box;
        background: transparent;
      }
      .dsh-sk *, .dsh-sk *::before, .dsh-sk *::after { box-sizing: border-box; }

      body[data-ds-dark-theme] .dsh-sk {
        --sk-bg: #151517;
        --sk-text: #f3f3f6;
        --sk-text-2: #a3a3ae;
        --sk-text-3: #8a8a94;
        --sk-line: #232328;
        --sk-line-strong: #303037;
        --sk-btn-bg: #1a1a1f;
        --sk-btn-line: #303037;
        --sk-btn-hover: #222228;
        --sk-row-hover: rgba(255, 255, 255, .045);
        --sk-green: #30d158;
        --sk-warn: #ff9f0a;
        --sk-accent: #4ea1ff;
        --sk-mark: color-mix(in srgb, var(--sk-accent) 26%, transparent);
        --sk-glass-top: rgba(255, 255, 255, .13);
        --sk-glass-bot: rgba(255, 255, 255, .05);
        --sk-glass-ring: rgba(255, 255, 255, .14);
        --sk-glass-hi: rgba(255, 255, 255, .3);
        --sk-glass-low: rgba(0, 0, 0, .35);
        --sk-glass-shadow: 0 1px 2px rgba(0, 0, 0, .5), 0 14px 34px -14px rgba(0, 0, 0, .8);
        --sk-glass-shadow-stuck: 0 1px 2px rgba(0, 0, 0, .6), 0 20px 40px -14px rgba(0, 0, 0, .95);
        --sk-shine: rgba(255, 255, 255, .34);
        --sk-shine-strength: .34;
        --sk-pop-bg: rgba(38, 38, 46, .78);
        --sk-kbd-bg: rgba(255, 255, 255, .1);
        --sk-kbd-low: rgba(0, 0, 0, .4);
        --sk-chip-bg: rgba(255, 255, 255, .09);
        --sk-chip-hover: rgba(255, 255, 255, .16);
        --sk-seg-track: rgba(255, 255, 255, .08);
        --sk-seg-thumb-a: rgba(255, 255, 255, .26);
        --sk-seg-thumb-b: rgba(255, 255, 255, .14);
        --sk-card-bg: #15151a;
        --sk-card-border: #2c2c36;
        --sk-card-shadow: 0 8px 26px -8px rgba(0, 0, 0, .6);
        --sk-code-bg: #0d0d12;
        --sk-code-border: #23232c;
        --sk-code-text: #dedee6;
        --sk-badge-bg: rgba(48, 209, 88, .15);
        --sk-badge-text: #30d158;
      }

      .dsh-sk::-webkit-scrollbar { width: 10px; height: 10px; }
      .dsh-sk::-webkit-scrollbar-thumb {
        background: color-mix(in srgb, var(--sk-text) 16%, transparent);
        border-radius: 999px;
        border: 3px solid transparent;
        background-clip: content-box;
      }
      .dsh-sk::-webkit-scrollbar-thumb:hover {
        background: color-mix(in srgb, var(--sk-text) 28%, transparent);
        border: 3px solid transparent;
        background-clip: content-box;
      }

      .dsh-sk-page {
        max-width: 1120px;
        margin: 0 auto;
        padding: 22px 21px 72px;
      }

      /* header */
      .dsh-sk-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        animation: dsh-sk-fade-up .7s var(--sk-ease) backwards;
      }
      .dsh-sk-head-text { flex: 1; min-width: 0; }
      .dsh-sk-title {
        margin: 0;
        color: var(--sk-text);
        font-size: 21px;
        font-weight: 700;
        line-height: 1.2;
        letter-spacing: -.01em;
      }
      .dsh-sk-sub {
        margin: 8px 0 0;
        color: var(--sk-text-2);
        font-size: 14px;
        line-height: 1.45;
        word-break: break-all;
      }
      .dsh-sk-refresh {
        position: relative;
        overflow: hidden;
        flex: none;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 7px 13px;
        border: 1px solid var(--sk-btn-line);
        border-radius: 9px;
        background: var(--sk-btn-bg);
        color: var(--sk-text);
        font: inherit;
        font-size: 13.5px;
        cursor: pointer;
        transition: background .25s, transform .4s var(--sk-spring), box-shadow .3s;
      }
      .dsh-sk-refresh:hover {
        background: var(--sk-btn-hover);
        box-shadow: 0 4px 14px -6px rgba(0, 0, 0, .25);
      }
      .dsh-sk-refresh:active { transform: scale(.94); }
      .dsh-sk-refresh:disabled { opacity: .55; cursor: default; }
      .dsh-sk-refresh svg { transition: transform .3s; }
      .dsh-sk-refresh.is-spinning svg { animation: dsh-sk-rot .9s var(--sk-ease); }

      /* sticky search + filter */
      .dsh-sk-sentinel { height: 1px; margin-bottom: -1px; }
      .dsh-sk-zone {
        position: sticky;
        top: 0;
        z-index: 30;
        padding: 14px 0 12px;
      }
      .dsh-sk-zone::before {
        content: "";
        position: absolute;
        z-index: -1;
        pointer-events: none;
        left: 50%;
        width: 100vw;
        top: 0;
        bottom: -28px;
        transform: translateX(-50%);
        background: linear-gradient(
          to bottom,
          var(--sk-bg-fade) 0%,
          var(--sk-bg-fade) 80%,
          transparent 100%
        );
        -webkit-backdrop-filter: blur(10px);
        backdrop-filter: blur(10px);
        -webkit-mask-image: linear-gradient(to bottom, #000 84%, transparent);
        mask-image: linear-gradient(to bottom, #000 84%, transparent);
        opacity: 0;
        transition: opacity .45s var(--sk-ease);
      }
      .dsh-sk-zone.is-stuck::before { opacity: 1; }
      .dsh-sk-zone.is-stuck .dsh-sk-field { box-shadow: var(--sk-glass-shadow-stuck); }
      .dsh-sk-zone-in { animation: dsh-sk-zone-in .9s var(--sk-spring) .12s backwards; }

      /* liquid glass search */
      .dsh-sk-search {
        position: relative;
        z-index: 2;
        isolation: isolate;
        --sk-mx: 50%;
        --sk-my: 50%;
      }
      .dsh-sk-field {
        position: relative;
        display: flex;
        align-items: center;
        height: 52px;
        padding: 0 12px 0 18px;
        border-radius: 999px;
        box-shadow: var(--sk-glass-shadow);
        cursor: text;
        transition: transform .45s var(--sk-spring), box-shadow .4s var(--sk-ease);
      }
      .dsh-sk-field:hover { transform: translateY(-1px); }
      .dsh-sk-search.is-focus .dsh-sk-field { transform: scale(1.008); }
      .dsh-sk-field.is-pulse { animation: dsh-sk-keypulse .3s var(--sk-ease); }
      .dsh-sk-search.is-flash .dsh-sk-field { animation: dsh-sk-commit .7s var(--sk-spring); }
      .dsh-sk-layer {
        position: absolute;
        inset: 0;
        border-radius: inherit;
        pointer-events: none;
      }
      .dsh-sk-glass {
        z-index: 1;
        background: linear-gradient(180deg, var(--sk-glass-top), var(--sk-glass-bot));
        -webkit-backdrop-filter: blur(16px) saturate(1.4);
        backdrop-filter: blur(16px) saturate(1.4);
        box-shadow:
          inset 0 0 0 1px var(--sk-glass-ring),
          inset 0 1.5px 1px var(--sk-glass-hi),
          inset 0 -3px 6px var(--sk-glass-low),
          inset 0 0 22px rgba(255, 255, 255, .18);
      }
      body[data-ds-dark-theme] .dsh-sk-glass {
        box-shadow:
          inset 0 0 0 1px var(--sk-glass-ring),
          inset 0 1.5px 1px var(--sk-glass-hi),
          inset 0 -3px 6px var(--sk-glass-low),
          inset 0 0 22px rgba(255, 255, 255, .05);
      }
      .dsh-sk-search.is-focus .dsh-sk-glass {
        box-shadow:
          inset 0 0 0 1.5px color-mix(in srgb, var(--sk-text) 16%, transparent),
          inset 0 1.5px 1px var(--sk-glass-hi),
          inset 0 -3px 6px var(--sk-glass-low),
          inset 0 0 22px rgba(255, 255, 255, .18);
      }
      body[data-ds-dark-theme] .dsh-sk-search.is-focus .dsh-sk-glass {
        box-shadow:
          inset 0 0 0 1.5px color-mix(in srgb, var(--sk-text) 22%, transparent),
          inset 0 1.5px 1px var(--sk-glass-hi),
          inset 0 -3px 6px var(--sk-glass-low),
          inset 0 0 22px rgba(255, 255, 255, .05);
      }
      .dsh-sk-shine {
        z-index: 2;
        overflow: hidden;
        opacity: 0;
        background: radial-gradient(200px circle at var(--sk-mx) var(--sk-my), var(--sk-shine), transparent 70%);
        transition: opacity .4s var(--sk-ease);
      }
      .dsh-sk-search:hover .dsh-sk-shine,
      .dsh-sk-search.is-focus .dsh-sk-shine { opacity: var(--sk-shine-strength); }

      .dsh-sk-icon {
        position: relative;
        z-index: 3;
        flex: none;
        width: 22px;
        height: 22px;
        margin-right: 12px;
        color: var(--sk-text-2);
        transition: color .3s, transform .5s var(--sk-spring);
      }
      .dsh-sk-icon svg { width: 100%; height: 100%; display: block; overflow: visible; }
      .dsh-sk-icon-handle { transition: transform .45s var(--sk-spring); }
      .dsh-sk-field:hover .dsh-sk-icon-handle { transform: translate(.8px, .8px); }
      .dsh-sk-search.is-focus .dsh-sk-icon { color: var(--sk-text); transform: scale(1.08); }
      .dsh-sk-search.is-focus .dsh-sk-icon svg { animation: dsh-sk-lens .8s var(--sk-spring); }

      .dsh-sk-input-wrap {
        position: relative;
        z-index: 3;
        flex: 1;
        min-width: 0;
        height: 100%;
        display: flex;
        align-items: center;
      }
      .dsh-sk-input {
        width: 100%;
        height: 100%;
        margin: 0;
        padding: 0;
        border: 0;
        outline: 0;
        background: transparent;
        color: var(--sk-text);
        caret-color: var(--sk-accent);
        font: inherit;
        font-size: 15.5px;
        letter-spacing: 0;
        position: relative;
        z-index: 2;
      }
      .dsh-sk-input::placeholder { color: var(--sk-text-3); opacity: 1; }
      .dsh-sk-ghost {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        pointer-events: none;
        color: transparent;
        font-size: 15.5px;
        letter-spacing: 0;
        white-space: pre;
        opacity: 0;
        transition: opacity .25s;
        z-index: 1;
      }
      .dsh-sk-ghost b { font-weight: 400; color: var(--sk-text-3); }
      .dsh-sk-search.has-ghost .dsh-sk-ghost { opacity: 1; }

      .dsh-sk-end { position: relative; z-index: 3; flex: none; display: flex; align-items: center; }
      .dsh-sk-kbd {
        display: inline-flex;
        align-items: center;
        height: 24px;
        padding: 0 8px;
        margin-left: 6px;
        border-radius: 8px;
        color: var(--sk-text-2);
        background: var(--sk-kbd-bg);
        font: 600 11px/1 ui-monospace, SFMono-Regular, Consolas, monospace;
        white-space: nowrap;
        overflow: hidden;
        max-width: 80px;
        box-shadow:
          inset 0 0 0 1px var(--sk-glass-ring),
          0 1px 0 var(--sk-kbd-low),
          inset 0 1px 0 var(--sk-glass-hi);
        transition: max-width .45s var(--sk-ease), opacity .25s,
          transform .5s var(--sk-spring), padding .45s var(--sk-ease), margin .45s var(--sk-ease);
      }
      .dsh-sk-k-tab {
        max-width: 0;
        padding: 0;
        margin-left: 0;
        opacity: 0;
        transform: scale(.6);
        color: var(--sk-accent);
      }
      .dsh-sk-search.has-ghost .dsh-sk-k-tab {
        max-width: 80px;
        padding: 0 8px;
        margin-left: 6px;
        opacity: 1;
        transform: none;
      }
      .dsh-sk-search.is-focus .dsh-sk-k-idle,
      .dsh-sk-search.has-value .dsh-sk-k-idle {
        max-width: 0;
        padding: 0;
        margin-left: 0;
        opacity: 0;
        transform: scale(.6);
      }
      .dsh-sk-clear {
        flex: none;
        display: grid;
        place-items: center;
        overflow: hidden;
        width: 26px;
        height: 26px;
        max-width: 0;
        margin-left: 0;
        padding: 0;
        border: 0;
        border-radius: 50%;
        background: var(--sk-chip-hover);
        color: var(--sk-text-2);
        opacity: 0;
        transform: scale(.3) rotate(-120deg);
        cursor: pointer;
        transition: max-width .45s var(--sk-ease), margin .45s var(--sk-ease), opacity .25s,
          transform .55s var(--sk-spring), background .2s, color .2s;
      }
      .dsh-sk-search.has-value .dsh-sk-clear {
        max-width: 26px;
        margin-left: 8px;
        opacity: 1;
        transform: none;
      }
      .dsh-sk-clear:hover { background: var(--sk-chip-hover); color: var(--sk-text); }
      .dsh-sk-search.has-value .dsh-sk-clear:active { transform: scale(.8) rotate(90deg); }

      /* search popover */
      .dsh-sk-pop {
        position: absolute;
        left: 6px;
        right: 6px;
        top: calc(100% + 12px);
        z-index: 5;
        display: flex;
        flex-direction: column;
        max-height: min(60vh, 440px);
        padding: 14px 14px 10px;
        border-radius: 26px;
        background: var(--sk-pop-bg);
        -webkit-backdrop-filter: blur(28px) saturate(1.4);
        backdrop-filter: blur(28px) saturate(1.4);
        box-shadow:
          inset 0 0 0 1px var(--sk-glass-ring),
          inset 0 1.5px 1px var(--sk-glass-hi),
          0 24px 60px -18px rgba(10, 10, 30, .42);
        opacity: 0;
        transform: translateY(-10px) scale(.96);
        transform-origin: 50% 0;
        pointer-events: none;
        transition: opacity .25s var(--sk-ease), transform .55s var(--sk-spring);
      }
      .dsh-sk-search.is-open .dsh-sk-pop {
        opacity: 1;
        transform: none;
        pointer-events: auto;
      }
      .dsh-sk-pop-scroll { min-height: 0; flex: 1 1 auto; overflow-y: auto; overflow-x: hidden; }
      .dsh-sk-pop-scroll::-webkit-scrollbar { width: 6px; }
      .dsh-sk-pop-scroll::-webkit-scrollbar-thumb {
        background: color-mix(in srgb, var(--sk-text) 18%, transparent);
        border-radius: 999px;
      }
      .dsh-sk-pop-sec + .dsh-sk-pop-sec { margin-top: 12px; }
      .dsh-sk-pop-title {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 6px 8px;
        color: var(--sk-text-3);
        font-size: 11.5px;
        font-weight: 600;
        letter-spacing: .04em;
      }
      .dsh-sk-pop-title button {
        border: 0;
        border-radius: 6px;
        padding: 2px 6px;
        background: none;
        color: var(--sk-text-3);
        font: inherit;
        font-size: 11.5px;
        letter-spacing: 0;
        cursor: pointer;
        transition: color .2s, background .2s;
      }
      .dsh-sk-pop-title button:hover { color: var(--sk-text); background: var(--sk-chip-bg); }

      .dsh-sk-recents, .dsh-sk-suggests { display: grid; gap: 2px; }
      .dsh-sk-recent-wrap { position: relative; }
      .dsh-sk-recent {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 36px 8px 10px;
        border-radius: 13px;
        color: var(--sk-text);
        font-size: 13.5px;
        cursor: pointer;
        transition: background .2s, transform .4s var(--sk-spring);
      }
      .dsh-sk-recent svg { flex: none; color: var(--sk-text-3); }
      .dsh-sk-recent span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dsh-sk-recent:hover { background: var(--sk-chip-bg); transform: translateX(3px); }
      .dsh-sk-recent.is-active {
        background: var(--sk-chip-hover);
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sk-text) 18%, transparent);
      }
      .dsh-sk-x {
        position: absolute;
        right: 8px;
        top: 50%;
        display: grid;
        place-items: center;
        width: 22px;
        height: 22px;
        padding: 0;
        border: 0;
        border-radius: 50%;
        background: none;
        color: var(--sk-text-3);
        opacity: 0;
        transform: translateY(-50%) scale(.6);
        cursor: pointer;
        transition: opacity .2s, transform .35s var(--sk-spring), background .2s, color .2s;
      }
      .dsh-sk-recent-wrap:hover .dsh-sk-x,
      .dsh-sk-recent-wrap.is-active .dsh-sk-x,
      .dsh-sk-recent-wrap:focus-within .dsh-sk-x {
        opacity: 1;
        transform: translateY(-50%);
      }
      .dsh-sk-x:hover { background: var(--sk-chip-hover); color: var(--sk-text); }

      .dsh-sk-suggestion {
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        padding: 8px 10px;
        border: 0;
        border-radius: 13px;
        background: none;
        color: var(--sk-text);
        font: inherit;
        font-size: 13.5px;
        text-align: left;
        cursor: pointer;
        transition: background .2s, transform .4s var(--sk-spring);
      }
      .dsh-sk-suggestion svg { flex: none; color: var(--sk-text-3); }
      .dsh-sk-suggestion:hover { background: var(--sk-chip-bg); transform: translateX(3px); }
      .dsh-sk-suggestion.is-active {
        background: var(--sk-chip-hover);
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sk-text) 18%, transparent);
      }
      .dsh-sk-suggestion-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

      .dsh-sk-pop-item {
        animation: dsh-sk-pop-in .55s var(--sk-spring) backwards;
        animation-delay: calc(var(--i, 0) * 32ms + 70ms);
      }
      .dsh-sk-pop.is-quiet .dsh-sk-pop-item { animation: none !important; }
      .dsh-sk-pop-foot {
        flex: none;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px 16px;
        margin-top: 12px;
        padding: 10px 6px 0;
        border-top: 1px solid var(--sk-glass-ring);
        color: var(--sk-text-3);
        font-size: 11.5px;
      }
      .dsh-sk-pop-foot .dsh-sk-kbd { height: 20px; padding: 0 6px; margin: 0 4px 0 0; font-size: 10.5px; }

      /* segmented filter */
      .dsh-sk-bar {
        position: relative;
        isolation: isolate;
        z-index: 1;
        margin-top: 14px;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        animation: dsh-sk-fade-up .8s var(--sk-ease) .3s backwards;
      }
      .dsh-sk-bar::before {
        content: "";
        position: absolute;
        z-index: -1;
        inset: -8px -8px -6px;
        border-radius: 18px;
        background: transparent;
        pointer-events: none;
        -webkit-backdrop-filter: blur(14px);
        backdrop-filter: blur(14px);
        transition: background .35s var(--sk-ease);
      }
      .dsh-sk-zone.is-stuck .dsh-sk-bar::before { background: var(--sk-bg-fade); }
      .dsh-sk-seg {
        position: relative;
        display: inline-flex;
        padding: 3px;
        border-radius: 999px;
        background: var(--sk-seg-track);
        box-shadow: inset 0 1px 3px rgba(0, 0, 0, .08), inset 0 0 0 1px var(--sk-glass-ring);
        -webkit-backdrop-filter: blur(10px);
        backdrop-filter: blur(10px);
      }
      .dsh-sk-seg-thumb {
        position: absolute;
        left: 0;
        top: 3px;
        bottom: 3px;
        width: 0;
        border-radius: 999px;
        pointer-events: none;
        background: linear-gradient(180deg, var(--sk-seg-thumb-a), var(--sk-seg-thumb-b));
        box-shadow:
          0 1px 3px rgba(0, 0, 0, .16),
          0 6px 14px -6px rgba(0, 0, 0, .28),
          inset 0 1px 0 var(--sk-glass-hi);
        transition: transform .6s var(--sk-spring), width .6s var(--sk-spring);
      }
      .dsh-sk-seg-thumb.no-anim { transition: none; }
      .dsh-sk-seg-thumb.squish { animation: dsh-sk-squish .55s var(--sk-ease); }
      .dsh-sk-seg-btn {
        position: relative;
        z-index: 1;
        display: inline-flex;
        align-items: center;
        gap: 7px;
        height: 30px;
        padding: 0 13px;
        border: 0;
        border-radius: 999px;
        background: none;
        color: var(--sk-text-2);
        font: inherit;
        font-size: 13px;
        cursor: pointer;
        transition: color .3s, transform .35s var(--sk-spring);
      }
      .dsh-sk-seg-btn:hover { color: var(--sk-text); }
      .dsh-sk-seg-btn:active { transform: scale(.94); }
      .dsh-sk-seg-btn.is-active { color: var(--sk-text); font-weight: 600; }
      .dsh-sk-num {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 20px;
        height: 20px;
        padding: 0 6px;
        border-radius: 999px;
        background: var(--sk-chip-bg);
        color: var(--sk-text-2);
        font-style: normal;
        font-size: 11px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        overflow: hidden;
      }
      .dsh-sk-seg-btn.is-active .dsh-sk-num { background: var(--sk-text); color: var(--sk-bg); }
      .dsh-sk-num-in { display: inline-block; animation: dsh-sk-roll .5s var(--sk-spring); }
      .dsh-sk-meta {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: var(--sk-text-3);
        font-size: 12.5px;
      }
      .dsh-sk-meta b { color: var(--sk-text); font-weight: 600; font-variant-numeric: tabular-nums; }
      .dsh-sk-kw {
        max-width: 160px;
        padding: 2px 9px;
        border-radius: 999px;
        background: var(--sk-mark);
        color: var(--sk-accent);
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        animation: dsh-sk-pop-in .45s var(--sk-spring);
      }

      /* rows */
      .dsh-sk-list { list-style: none; margin: 4px -10px 0; padding: 0; }
      .dsh-sk-row {
        position: relative;
        display: grid;
        grid-template-rows: 1fr;
        transition: grid-template-rows .5s var(--sk-ease), opacity .35s var(--sk-ease),
          transform .5s var(--sk-ease);
        transition-delay: calc(min(var(--vi, 0), 10) * 22ms);
      }
      .dsh-sk-row.is-hidden {
        grid-template-rows: 0fr;
        opacity: 0;
        transform: translateY(-8px) scale(.985);
        transition-delay: 0s;
        pointer-events: none;
      }
      .dsh-sk-row-inner { overflow: hidden; min-height: 0; }
      .dsh-sk-list .dsh-sk-row-inner {
        animation: dsh-sk-row-in .75s var(--sk-ease) backwards;
        animation-delay: calc(min(var(--i, 0), 12) * 40ms + 160ms);
      }
      .dsh-sk-row-pad {
        position: relative;
        display: flex;
        align-items: center;
        gap: 14px;
        padding: 13px 10px 13px 35px;
        border-radius: 14px;
        transition: background .25s;
      }
      .dsh-sk-row-pad::after {
        content: "";
        position: absolute;
        left: 10px;
        right: 10px;
        bottom: 0;
        height: 1px;
        background: var(--sk-line);
        transition: opacity .25s;
      }
      .dsh-sk-row-pad:hover { background: var(--sk-row-hover); }
      .dsh-sk-row-pad:hover::after,
      .dsh-sk-row.is-expanded .dsh-sk-row-pad::after { opacity: 0; }
      .dsh-sk-row.is-expanded::after {
        content: "";
        position: absolute;
        left: 10px;
        right: 10px;
        bottom: 0;
        height: 1px;
        background: var(--sk-line);
      }
      .dsh-sk-dot {
        position: absolute;
        left: 13px;
        top: 50%;
        width: 8px;
        height: 8px;
        margin-top: -4px;
        border-radius: 50%;
        color: var(--dsw-alias-state-idle-primary, #d4d4d4);
        background: currentColor;
        transition: color .4s;
      }
      .dsh-sk-dot::after {
        content: "";
        position: absolute;
        inset: 0;
        border-radius: 50%;
        background: currentColor;
        opacity: 0;
      }
      .dsh-sk-dot[data-state="done"] { color: var(--sk-green); }
      .dsh-sk-dot[data-state="warning"] { color: var(--sk-warn); }
      .dsh-sk-dot[data-state="ongoing"] { color: var(--sk-accent); }
      .dsh-sk-dot[data-state="idle"] { color: var(--dsw-alias-state-idle-primary, #d4d4d4); }
      .dsh-sk-dot[data-state="done"]::after,
      .dsh-sk-dot[data-state="ongoing"]::after {
        opacity: .5;
        animation: dsh-sk-dot-pulse 2.6s ease-out infinite;
      }
      .dsh-sk-dot[data-state="ongoing"]::after { animation-duration: 1.5s; }
      .dsh-sk-row-text { flex: 1; min-width: 0; }
      .dsh-sk-name-line { display: flex; align-items: center; gap: 8px; min-width: 0; }
      .dsh-sk-name {
        min-width: 0;
        overflow: hidden;
        color: var(--sk-text);
        font-size: 15px;
        font-weight: 600;
        letter-spacing: -.005em;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .dsh-sk-tag-desc {
        flex: none;
        padding: 1px 8px;
        border-radius: 999px;
        background: var(--sk-mark);
        color: var(--sk-accent);
        font-size: 10.5px;
        font-weight: 600;
        animation: dsh-sk-pop-in .45s var(--sk-spring);
      }
      .dsh-sk-desc {
        margin-top: 3px;
        color: var(--sk-text-2);
        font-size: 13px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .dsh-sk-st { color: var(--sk-text-3); }
      .dsh-sk-st.is-warn { color: var(--sk-warn); }
      .dsh-sk mark {
        margin: 0 -1px;
        padding: 0 2px;
        border-radius: 4px;
        background: var(--sk-mark);
        color: inherit;
        box-shadow: 0 0 0 1px var(--sk-mark);
        animation: dsh-sk-mark-in .45s var(--sk-ease) backwards;
      }
      .dsh-sk-row-actions { flex: none; display: flex; align-items: center; gap: 10px; }
      .dsh-sk-btn-detail {
        padding: 5px 12px;
        border: 1px solid var(--sk-btn-line);
        border-radius: 8px;
        background: var(--sk-btn-bg);
        color: var(--sk-text);
        font: inherit;
        font-size: 13px;
        cursor: pointer;
        user-select: none;
        transition: background .2s, transform .4s var(--sk-spring), box-shadow .3s,
          border-color .3s, color .3s;
      }
      .dsh-sk-btn-detail:hover {
        background: var(--sk-btn-hover);
        box-shadow: 0 4px 12px -6px rgba(0, 0, 0, .3);
      }
      .dsh-sk-btn-detail:active { transform: scale(.92); }
      .dsh-sk-btn-detail.is-active {
        background: var(--sk-btn-hover);
        border-color: color-mix(in srgb, var(--sk-accent) 35%, transparent);
        color: var(--sk-accent);
        box-shadow: 0 0 0 2px var(--sk-mark);
      }

      /* detail */
      .dsh-sk-detail-wrap {
        display: grid;
        grid-template-rows: 0fr;
        transition: grid-template-rows .45s var(--sk-ease);
      }
      .dsh-sk-row.is-expanded .dsh-sk-detail-wrap { grid-template-rows: 1fr; }
      .dsh-sk-detail-overflow { overflow: hidden; min-height: 0; }
      .dsh-sk-card {
        position: relative;
        margin: 4px 10px 14px;
        padding: 16px 20px 18px;
        border: 1px solid var(--sk-card-border);
        border-radius: 9px;
        background: var(--sk-card-bg);
        box-shadow: var(--sk-card-shadow);
        transform-origin: top center;
        transition: background .4s var(--sk-ease), border-color .4s var(--sk-ease),
          box-shadow .4s var(--sk-ease);
      }
      .dsh-sk-row.is-expanded .dsh-sk-card { animation: dsh-sk-card-expand .45s var(--sk-spring) forwards; }
      .dsh-sk-row.is-expanded .dsh-sk-card > * {
        animation: dsh-sk-item-slide .4s var(--sk-ease) backwards;
      }
      .dsh-sk-row.is-expanded .dsh-sk-card > :nth-child(1) { animation-delay: .06s; }
      .dsh-sk-row.is-expanded .dsh-sk-card > :nth-child(2) { animation-delay: .1s; }
      .dsh-sk-row.is-expanded .dsh-sk-card > :nth-child(3) { animation-delay: .14s; }
      .dsh-sk-row.is-expanded .dsh-sk-card > :nth-child(4) { animation-delay: .18s; }
      .dsh-sk-row.is-expanded .dsh-sk-card > :nth-child(5) { animation-delay: .22s; }
      .dsh-sk-row.is-expanded .dsh-sk-card > :nth-child(6) { animation-delay: .26s; }
      .dsh-sk-field-row {
        display: flex;
        align-items: flex-start;
        gap: 16px;
        margin-bottom: 12px;
        font-size: 13.5px;
      }
      .dsh-sk-label {
        flex: none;
        width: var(--sk-label-width, 96px);
        padding-top: 1px;
        color: var(--sk-text-2);
        font-size: 13px;
        font-weight: 500;
        letter-spacing: .01em;
        user-select: none;
      }
      .dsh-sk-val {
        flex: 1;
        min-width: 0;
        color: var(--sk-text);
        line-height: 1.6;
        word-break: break-word;
      }
      .dsh-sk-badge {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 1px 8px;
        border-radius: 6px;
        background: var(--sk-badge-bg);
        color: var(--sk-badge-text);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12.5px;
        font-weight: 600;
      }
      .dsh-sk-badge::before {
        content: "";
        display: inline-block;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: currentColor;
      }
      .dsh-sk-badge.is-off { background: var(--sk-chip-bg); color: var(--sk-text-2); }
      .dsh-sk-path-box {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 13px;
      }
      .dsh-sk-path {
        min-width: 0;
        overflow: hidden;
        padding: 2px 0;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .dsh-sk-copy {
        flex: none;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 3px 8px;
        border: 0;
        border-radius: 6px;
        background: var(--sk-chip-bg);
        color: var(--sk-text-2);
        font: inherit;
        font-size: 11.5px;
        font-weight: 500;
        cursor: pointer;
        user-select: none;
        transition: background .2s, color .2s, transform .2s var(--sk-spring);
      }
      .dsh-sk-copy:hover { background: var(--sk-chip-hover); color: var(--sk-text); transform: translateY(-1px); }
      .dsh-sk-copy:active { transform: scale(.94); }
      .dsh-sk-copy.is-copied { background: rgba(34, 197, 94, .18); color: var(--sk-green); }
      .dsh-sk-code {
        margin-top: 14px;
        border: 1px solid var(--sk-code-border);
        border-radius: 8px;
        background: var(--sk-code-bg);
        overflow: hidden;
      }
      .dsh-sk-code-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 6px 12px;
        border-bottom: 1px solid var(--sk-code-border);
        background: color-mix(in srgb, var(--sk-text) 4%, transparent);
        color: var(--sk-text-3);
        font-size: 11.5px;
        user-select: none;
      }
      .dsh-sk-code-name {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: var(--sk-text-2);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-weight: 500;
      }
      .dsh-sk-code-pre {
        margin: 0;
        padding: 14px 16px;
        max-height: 220px;
        overflow-y: auto;
        color: var(--sk-code-text);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono",
          "Courier New", monospace;
        font-size: 12.5px;
        line-height: 1.62;
        white-space: pre-wrap;
        word-break: break-all;
      }
      .dsh-sk-code-pre::-webkit-scrollbar { width: 6px; height: 6px; }
      .dsh-sk-code-pre::-webkit-scrollbar-thumb {
        background: color-mix(in srgb, var(--sk-text) 22%, transparent);
        border-radius: 999px;
      }
      .dsh-sk-code-pre::-webkit-scrollbar-thumb:hover {
        background: color-mix(in srgb, var(--sk-text) 40%, transparent);
      }
      .dsh-sk-detail-foot {
        margin-top: 12px;
        color: var(--sk-text-3);
        font-size: 12px;
        letter-spacing: .01em;
        user-select: none;
      }

      /* quiet notes and the caveat */
      .dsh-sk-note {
        margin: 0 0 10px;
        color: var(--sk-text-3);
        font-size: 12px;
        line-height: 1.55;
      }
      .dsh-sk-note.is-error { color: var(--dsw-alias-label-error, #e5534b); }
      .dsh-sk-note.is-warning { color: var(--sk-warn); }
      .dsh-sk-caveat {
        margin: 18px 0 0;
        padding-top: 12px;
        border-top: 1px solid var(--sk-line);
        color: var(--sk-text-3);
        font-size: 11px;
        line-height: 1.55;
      }
      .dsh-sk-uninstall { margin-top: 12px; }

      /* empty state */
      .dsh-sk-empty {
        display: grid;
        justify-items: center;
        gap: 10px;
        overflow: hidden;
        max-height: 0;
        padding: 0;
        opacity: 0;
        text-align: center;
        transform: translateY(12px);
        pointer-events: none;
        transition: max-height .5s var(--sk-ease), opacity .4s var(--sk-ease),
          transform .6s var(--sk-spring), padding .5s var(--sk-ease);
      }
      .dsh-sk-empty.is-show {
        max-height: 420px;
        padding: 54px 0 20px;
        opacity: 1;
        transform: none;
        pointer-events: auto;
        transition-delay: .15s;
      }
      .dsh-sk-empty-ico {
        display: grid;
        place-items: center;
        width: 64px;
        height: 64px;
        border-radius: 50%;
        color: var(--sk-text-2);
        background: linear-gradient(180deg, var(--sk-glass-top), var(--sk-glass-bot));
        box-shadow:
          inset 0 0 0 1px var(--sk-glass-ring),
          inset 0 1.5px 1px var(--sk-glass-hi),
          var(--sk-glass-shadow);
      }
      .dsh-sk-empty.is-show .dsh-sk-empty-ico svg { animation: dsh-sk-wobble 1.4s var(--sk-ease) .3s; }
      .dsh-sk-empty-title { margin: 0; color: var(--sk-text); font-size: 15px; font-weight: 600; }
      .dsh-sk-empty-title em { color: var(--sk-accent); font-style: normal; }
      .dsh-sk-empty-body { margin: 0; color: var(--sk-text-3); font-size: 13px; }
      .dsh-sk-empty-btn { margin-top: 4px; padding: 7px 16px; }

      /* loading */
      .dsh-sk-loading {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        padding: 44px 0;
        color: var(--sk-text-3);
        font-size: 13px;
      }
      .dsh-sk-spinner {
        width: 16px;
        height: 16px;
        border: 2px solid var(--sk-line-strong);
        border-top-color: var(--sk-text-2);
        border-radius: 50%;
        animation: dsh-sk-rot .8s linear infinite;
      }

      /* toast */
      .dsh-sk-toast {
        position: fixed;
        left: 50%;
        bottom: 30px;
        z-index: 80;
        display: inline-flex;
        align-items: center;
        gap: 9px;
        padding: 11px 18px 11px 14px;
        border-radius: 999px;
        background: var(--sk-pop-bg);
        color: var(--sk-text);
        font-size: 13.5px;
        opacity: 0;
        pointer-events: none;
        transform: translate(-50%, 24px) scale(.88);
        -webkit-backdrop-filter: blur(24px) saturate(1.4);
        backdrop-filter: blur(24px) saturate(1.4);
        box-shadow:
          inset 0 0 0 1px var(--sk-glass-ring),
          inset 0 1.5px 1px var(--sk-glass-hi),
          0 16px 40px -14px rgba(10, 10, 30, .4);
        transition: transform .6s var(--sk-spring), opacity .3s;
      }
      .dsh-sk-toast.is-show { opacity: 1; transform: translate(-50%, 0) scale(1); }
      .dsh-sk-toast svg { flex: none; color: var(--sk-green); }

      .dsh-sk button { appearance: none; }
      .dsh-sk button:focus-visible:not([role="switch"]),
      .dsh-sk [role="option"]:focus-visible { outline: 2px solid var(--sk-accent); outline-offset: 2px; }
      .dsh-sk .dsh-sk-input:focus-visible { outline: none; }

      @keyframes dsh-sk-fade-up { from { opacity: 0; transform: translateY(12px); } }
      @keyframes dsh-sk-zone-in { from { opacity: 0; transform: translateY(10px) scale(.94); } }
      @keyframes dsh-sk-rot { to { transform: rotate(360deg); } }
      @keyframes dsh-sk-lens {
        0% { transform: rotate(0); }
        35% { transform: rotate(-20deg) scale(1.12); }
        100% { transform: rotate(0); }
      }
      @keyframes dsh-sk-keypulse { 40% { transform: scale(1.016); } }
      @keyframes dsh-sk-commit { 30% { transform: scale(1.028); } }
      @keyframes dsh-sk-pop-in {
        from { opacity: 0; transform: translateY(10px) scale(.92); }
      }
      @keyframes dsh-sk-row-in {
        from { opacity: 0; transform: translateY(16px); filter: blur(4px); }
      }
      @keyframes dsh-sk-roll {
        from { opacity: 0; transform: translateY(70%); filter: blur(2px); }
      }
      @keyframes dsh-sk-mark-in {
        from { background: transparent; box-shadow: 0 0 0 0 transparent; }
      }
      @keyframes dsh-sk-card-expand {
        from { opacity: 0; transform: translateY(-6px) scale(.995); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
      @keyframes dsh-sk-item-slide {
        from { opacity: 0; transform: translateY(8px); }
        to { opacity: 1; transform: translateY(0); }
      }
      @keyframes dsh-sk-dot-pulse {
        0% { transform: scale(1); opacity: .5; }
        70%, 100% { transform: scale(2.8); opacity: 0; }
      }
      @keyframes dsh-sk-squish {
        0% { scale: 1 1; }
        30% { scale: 1.16 .86; }
        100% { scale: 1 1; }
      }
      @keyframes dsh-sk-wobble {
        0% { transform: rotate(0); }
        20% { transform: rotate(-16deg); }
        45% { transform: rotate(12deg); }
        70% { transform: rotate(-6deg); }
        100% { transform: rotate(0); }
      }

      @media (max-width: 720px) {
        .dsh-sk-page { padding: 16px 14px 56px; }
        .dsh-sk-title { font-size: 19px; }
        .dsh-sk-sub { font-size: 13px; }
        .dsh-sk-field { height: 48px; padding-left: 15px; }
        .dsh-sk-k-idle { display: none; }
        .dsh-sk-row-pad { gap: 10px; padding: 12px 8px 12px 30px; }
        .dsh-sk-row-actions { gap: 7px; }
        .dsh-sk-btn-detail { padding: 5px 9px; }
        .dsh-sk-card { padding: 14px 14px 16px; }
        .dsh-sk-path-box { font-size: 11.5px; }
      }
      @media (max-width: 460px) {
        .dsh-sk-field-row { flex-direction: column; gap: 4px; }
        .dsh-sk-label { width: auto; }
        .dsh-sk-seg-btn { gap: 5px; padding: 0 10px; font-size: 12.5px; }
        .dsh-sk-num { min-width: 18px; height: 18px; padding: 0 5px; font-size: 10.5px; }
      }
      @media (prefers-reduced-motion: reduce) {
        .dsh-sk *,
        .dsh-sk *::before,
        .dsh-sk *::after {
          animation-duration: .01ms !important;
          animation-iteration-count: 1 !important;
          transition-duration: .01ms !important;
        }
      }
    `

    // ------------------------------------------------------------ panel helpers

    const RECENTS_KEY = 'dsh-panel-skills:search-recents'
    const MAX_RECENTS = 5
    const IS_MAC =
      typeof navigator !== 'undefined' &&
      /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

    /**
     * The recent searches survive a page refresh, so a query the user confirmed
     * once is one click away the next day. A storage failure is not worth a
     * broken search field: the list simply starts empty.
     * @returns the stored queries, at most MAX_RECENTS.
     */
    function readRecents() {
      try {
        const raw = localStorage.getItem(RECENTS_KEY)
        if (raw === null || raw === '') return []
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []
        return parsed
          .filter((item) => typeof item === 'string' && item.trim() !== '')
          .slice(0, MAX_RECENTS)
      } catch {
        return []
      }
    }

    /**
     * Persist the recent-query list. Private-mode storage failures are ignored.
     * @param list - the queries to store.
     */
    function saveRecents(list) {
      try {
        localStorage.setItem(RECENTS_KEY, JSON.stringify(list))
      } catch {
        // A full or unavailable storage area must not take the panel down.
      }
    }

    /** Escape a string before it is used as a regular expression. */
    function escapeRegExp(text) {
      return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }

    /**
     * Wrap every query token in `<mark>`, without injecting markup: the text is
     * split around the matches and React renders the pieces.
     * @param props - the text and the lower-cased query tokens.
     * @returns the highlighted string, or the plain string when nothing matches.
     */
    function Highlight({ text, tokens }) {
      if (text === undefined || text === null || text === '') return null
      const value = String(text)
      const active = Array.isArray(tokens)
        ? tokens.filter((token) => typeof token === 'string' && token !== '')
        : []
      if (active.length === 0) return value
      const pattern = new RegExp(
        '(' + active.slice().sort((a, b) => b.length - a.length).map(escapeRegExp).join('|') + ')',
        'gi',
      )
      return value
        .split(pattern)
        .map((part, index) => (index % 2 === 1 ? jsx('mark', { key: index, children: part }) : part))
    }

    /**
     * Copy through the async clipboard, falling back to the legacy command for
     * an insecure or permission-limited context.
     * @param text - the text to copy.
     * @returns a promise resolved after the copy attempt.
     */
    function writeClipboard(text) {
      const value = String(text ?? '')
      if (
        typeof navigator !== 'undefined' &&
        navigator.clipboard &&
        typeof navigator.clipboard.writeText === 'function'
      ) {
        return navigator.clipboard.writeText(value).catch(() => fallbackCopy(value))
      }
      return fallbackCopy(value)
    }

    /** The deprecated copy path, kept for contexts without `navigator.clipboard`. */
    function fallbackCopy(value) {
      return new Promise((resolve, reject) => {
        try {
          const area = document.createElement('textarea')
          area.value = value
          area.setAttribute('readonly', '')
          area.style.position = 'fixed'
          area.style.opacity = '0'
          document.body.appendChild(area)
          area.select()
          const ok = document.execCommand('copy')
          area.remove()
          if (ok) resolve()
          else reject(new Error('copy failed'))
        } catch (error) {
          reject(error)
        }
      })
    }

    /** A small copy button that reports its own success for a moment. */
    function CopyButton({ text, label, doneLabel, title, onCopied, onError }) {
      const [copied, setCopied] = useState(false)
      const timer = useRef(0)
      useEffect(() => () => clearTimeout(timer.current), [])
      const handleClick = () => {
        writeClipboard(text)
          .then(() => {
            setCopied(true)
            if (onCopied !== undefined) onCopied()
            clearTimeout(timer.current)
            timer.current = setTimeout(() => setCopied(false), 1600)
          })
          .catch(() => {
            if (onError !== undefined) onError()
          })
      }
      return jsxs('button', {
        type: 'button',
        className: 'dsh-sk-copy' + (copied ? ' is-copied' : ''),
        title: title ?? label,
        onClick: handleClick,
        children: [
          jsx(IconCopy, { size: 12 }),
          jsx('span', { children: copied ? doneLabel : label }),
        ],
      })
    }

    /** A count that rolls when it changes, without remounting its button. */
    function RollingNumber({ value }) {
      return jsx('i', {
        className: 'dsh-sk-num',
        children: jsx('span', {
          key: String(value),
          className: 'dsh-sk-num-in',
          children: value,
        }),
      })
    }

    function IconSearch({ size = 22 }) {
      return jsxs('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2.1,
        strokeLinecap: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        children: [
          jsx('circle', { cx: 11, cy: 11, r: 6.5 }),
          jsx('path', { className: 'dsh-sk-icon-handle', d: 'M16.2 16.2 20.2 20.2' }),
        ],
      })
    }

    function IconRefresh({ size = 15 }) {
      return jsxs('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        children: [
          jsx('path', { d: 'M21 12a9 9 0 1 1-2.64-6.36' }),
          jsx('path', { d: 'M21 3v6h-6' }),
        ],
      })
    }

    function IconClock({ size = 15 }) {
      return jsxs('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        children: [
          jsx('circle', { cx: 12, cy: 12, r: 9 }),
          jsx('path', { d: 'M12 7v5l3 2' }),
        ],
      })
    }

    function IconX({ size = 12 }) {
      return jsx('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 3,
        strokeLinecap: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        children: jsx('path', { d: 'M6 6l12 12M18 6 6 18' }),
      })
    }

    function IconCopy({ size = 12 }) {
      return jsxs('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2.2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        children: [
          jsx('rect', { x: 9, y: 9, width: 13, height: 13, rx: 2, ry: 2 }),
          jsx('path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' }),
        ],
      })
    }

    function IconFile({ size = 12 }) {
      return jsxs('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        children: [
          jsx('path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' }),
          jsx('path', { d: 'M14 2v6h6' }),
          jsx('line', { x1: 16, y1: 13, x2: 8, y2: 13 }),
          jsx('line', { x1: 16, y1: 17, x2: 8, y2: 17 }),
        ],
      })
    }

    function IconCheck({ size = 18 }) {
      return jsxs('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        children: [
          jsx('circle', { cx: 12, cy: 12, r: 9.5 }),
          jsx('path', { d: 'm8 12.4 2.7 2.7L16 9.8' }),
        ],
      })
    }

    function IconEmptySearch({ size = 28 }) {
      return jsxs('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        children: [
          jsx('circle', { cx: 11, cy: 11, r: 6.5 }),
          jsx('path', { d: 'M16.2 16.2 20.2 20.2M9 9l4 4M13 9l-4 4' }),
        ],
      })
    }

    /**
     * The segmented status filter. The thumb is measured rather than assumed,
     * because the three labels and their counts have different widths.
     */
    function SegmentedFilter({ value, onChange, counts, t }) {
      const items = [
        { id: 'all', label: t('skills.filter.all'), count: counts.all },
        { id: 'on', label: t('skills.filter.on'), count: counts.on },
        { id: 'off', label: t('skills.filter.off'), count: counts.off },
      ]
      const segRef = useRef(null)
      const btnRefs = useRef([])
      const [thumb, setThumb] = useState({ width: 0, x: 0 })
      const [animate, setAnimate] = useState(false)
      const [squish, setSquish] = useState(false)
      const squishTimer = useRef(0)
      const squishNext = useRef(false)

      const measure = useCallback(
        (withAnimation) => {
          const index = items.findIndex((item) => item.id === value)
          const btn = btnRefs.current[index]
          if (btn === undefined) return
          const next = { width: btn.offsetWidth, x: btn.offsetLeft }
          setThumb((prev) =>
            prev.width === next.width && prev.x === next.x ? prev : next,
          )
          if (withAnimation) {
            setSquish(true)
            clearTimeout(squishTimer.current)
            squishTimer.current = setTimeout(() => setSquish(false), 560)
          }
        },
        [value, counts.all, counts.on, counts.off, t],
      )

      useLayoutEffect(() => {
        measure(squishNext.current)
        squishNext.current = false
      }, [measure])

      useEffect(() => {
        const timer = setTimeout(() => setAnimate(true), 60)
        return () => {
          clearTimeout(timer)
          clearTimeout(squishTimer.current)
        }
      }, [])

      useEffect(() => {
        if (typeof ResizeObserver !== 'function' || segRef.current === null) return undefined
        const observer = new ResizeObserver(() => measure(false))
        observer.observe(segRef.current)
        return () => observer.disconnect()
      }, [measure])

      useEffect(() => {
        let live = true
        if (document.fonts && document.fonts.ready) {
          document.fonts.ready.then(() => {
            if (live) measure(false)
          })
        }
        return () => {
          live = false
        }
      }, [measure])

      const select = (id) => {
        if (id === value) return
        squishNext.current = true
        onChange(id)
      }

      return jsxs('div', {
        className: 'dsh-sk-seg',
        ref: segRef,
        role: 'tablist',
        'aria-label': t('skills.filter.label'),
        children: [
          jsx('span', {
            className:
              'dsh-sk-seg-thumb' +
              (animate ? '' : ' no-anim') +
              (squish ? ' squish' : ''),
            style: {
              width: thumb.width === 0 ? 0 : thumb.width + 'px',
              transform: 'translateX(' + thumb.x + 'px)',
            },
            'aria-hidden': 'true',
          }),
          ...items.map((item, index) =>
            jsxs(
              'button',
              {
                type: 'button',
                role: 'tab',
                'aria-selected': item.id === value,
                className: 'dsh-sk-seg-btn' + (item.id === value ? ' is-active' : ''),
                ref: (element) => {
                  btnRefs.current[index] = element
                },
                onClick: () => select(item.id),
                children: [item.label, jsx(RollingNumber, { value: item.count })],
              },
              item.id,
            ),
          ),
        ],
      })
    }

    /**
     * The empty state. It is kept mounted so both directions animate, and made
     * inert while collapsed so its button cannot be tabbed from hiding.
     */
    function EmptyState({ show, title, body, actionLabel, onAction }) {
      const ref = useRef(null)
      useEffect(() => {
        if (ref.current !== null) ref.current.inert = !show
      }, [show])
      return jsxs('div', {
        className: 'dsh-sk-empty' + (show ? ' is-show' : ''),
        ref,
        children: [
          jsx('div', { className: 'dsh-sk-empty-ico', children: jsx(IconEmptySearch, { size: 28 }) }),
          jsx('h3', { className: 'dsh-sk-empty-title', children: title }),
          body === undefined ? null : jsx('p', { className: 'dsh-sk-empty-body', children: body }),
          actionLabel === undefined
            ? null
            : jsx('button', {
                type: 'button',
                className: 'dsh-sk-btn-detail dsh-sk-empty-btn',
                onClick: onAction,
                children: actionLabel,
              }),
        ],
      })
    }

    /**
     * One skill's detail card. The read is per open, so a file edited between
     * visits is read again; closing keeps the card mounted for the collapse
     * transition (the row owns that timer) but stops the read.
     */
    function SkillDetail({ row, open, remote, session, t, showToast, tokens }) {
      const [state, setState] = useState(undefined)
      const sessionId = session?.sessionId

      useEffect(() => {
        if (!open) return undefined
        if (typeof row.path !== 'string' || row.path === '') {
          setState(undefined)
          return undefined
        }
        const files = remote.workspaceFiles
        if (files === undefined || typeof files.read !== 'function') {
          setState({ status: 'error', error: t('skills.detail.noFileApi') })
          return undefined
        }
        if (sessionId === undefined) {
          setState({ status: 'error', error: t('skills.noSession') })
          return undefined
        }
        let live = true
        setState({ status: 'loading' })
        files
          .read(sessionId, row.path, { limit: DETAIL_PAGE_LINES })
          .then((result) => {
            if (!live) return
            if (!result.ok) {
              setState({
                status: 'error',
                error: `${result.error.code}: ${result.error.message}`,
              })
              return
            }
            setState({
              status: 'ready',
              text: typeof result.value?.text === 'string' ? result.value.text : '',
              lines:
                typeof result.value?.lines === 'number' ? result.value.lines : DETAIL_PAGE_LINES,
              eof: result.value?.eof !== false,
            })
          })
          .catch((error) => {
            if (live) setState({ status: 'error', error: String(error?.message ?? error) })
          })
        return () => {
          live = false
        }
      }, [open, row.path, sessionId, remote, t])

      const field = (label, value) =>
        jsxs('div', {
          className: 'dsh-sk-field-row',
          children: [
            jsx('span', { className: 'dsh-sk-label', children: label }),
            jsx('div', { className: 'dsh-sk-val', children: value }),
          ],
        })

      const path = typeof row.path === 'string' && row.path !== '' ? row.path : undefined
      const loading = state === undefined || state.status === 'loading'
      const ready = state !== undefined && state.status === 'ready'
      const failed = state !== undefined && state.status === 'error'

      return jsxs('div', {
        className: 'dsh-sk-card',
        children: [
          row.description
            ? field(
                t('skills.detail.description'),
                jsx(Highlight, { text: row.description, tokens }),
              )
            : null,
          row.whenToUse
            ? field(
                t('skills.detail.whenToUse'),
                jsx(Highlight, { text: row.whenToUse, tokens }),
              )
            : null,
          typeof row.modelInvocable === 'boolean'
            ? field(
                t('skills.detail.modelInvocable'),
                jsx('span', {
                  className: 'dsh-sk-badge' + (row.modelInvocable ? '' : ' is-off'),
                  children: String(row.modelInvocable),
                }),
              )
            : null,
          path === undefined
            ? null
            : field(
                t('skills.detail.path'),
                jsxs('div', {
                  className: 'dsh-sk-path-box',
                  children: [
                    jsx('span', {
                      className: 'dsh-sk-path',
                      title: path,
                      children: jsx(Highlight, { text: path, tokens }),
                    }),
                    jsx(CopyButton, {
                      text: path,
                      label: t('skills.copy.path'),
                      doneLabel: t('skills.copy.done'),
                      onCopied: () => showToast(t('skills.toast.pathCopied')),
                      onError: () => showToast(t('skills.copy.failed')),
                    }),
                  ],
                }),
              ),
          path === undefined
            ? jsx('p', { className: 'dsh-sk-note', children: t('skills.detail.noPath') })
            : loading
              ? jsx('p', { className: 'dsh-sk-note', children: t('skills.detail.loading') })
              : failed
                ? jsx('p', {
                    className: 'dsh-sk-note is-error',
                    role: 'alert',
                    children: `${t('skills.detail.error')}: ${String(state.error)}`,
                  })
                : ready
                  ? jsxs('div', {
                      className: 'dsh-sk-code',
                      children: [
                        jsxs('div', {
                          className: 'dsh-sk-code-bar',
                          children: [
                            jsxs('span', {
                              className: 'dsh-sk-code-name',
                              children: [jsx(IconFile, { size: 12 }), t('skills.detail.file')],
                            }),
                            jsx(CopyButton, {
                              text: state.text,
                              label: t('skills.copy.file'),
                              doneLabel: t('skills.copy.fileDone'),
                              onCopied: () => showToast(t('skills.toast.fileCopied')),
                              onError: () => showToast(t('skills.copy.failed')),
                            }),
                          ],
                        }),
                        jsx('pre', {
                          className: 'dsh-sk-code-pre',
                          children: jsx('code', {
                            children:
                              state.text === '' ? t('skills.detail.empty') : state.text,
                          }),
                        }),
                      ],
                    })
                  : null,
          ready
            ? jsx('div', {
                className: 'dsh-sk-detail-foot',
                children: `${t('skills.detail.lines').replace('{n}', String(state.lines ?? 0))}${
                  state.eof === true
                    ? ''
                    : ' ' + t('skills.detail.more').replace('{n}', String(state.lines ?? 0))
                }`,
              })
            : null,
        ],
      })
    }

    /** One catalog row, its toggle, and its expandable detail card. */
    function SkillRow({
      row,
      index,
      visibleIndex,
      hidden,
      off,
      detailOpen,
      saving,
      dotState,
      statusText,
      extra,
      tokens,
      t,
      remote,
      session,
      onToggleDetail,
      onToggle,
      showToast,
    }) {
      const rowRef = useRef(null)
      const wasOpen = useRef(detailOpen)
      const [closing, setClosing] = useState(false)

      useEffect(() => {
        if (rowRef.current !== null) rowRef.current.inert = hidden
      }, [hidden])

      useEffect(() => {
        if (detailOpen) {
          wasOpen.current = true
          setClosing(false)
          return undefined
        }
        if (!wasOpen.current) return undefined
        wasOpen.current = false
        setClosing(true)
        const timer = setTimeout(() => setClosing(false), 480)
        return () => clearTimeout(timer)
      }, [detailOpen])

      const descOnly =
        tokens.length > 0 && !tokens.every((token) => row.name.toLowerCase().includes(token))
      const showDetail = detailOpen || closing
      const fullMeta = [statusText, extra, row.description].filter(Boolean).join(' · ')

      return jsxs(
        'li',
        {
          ref: rowRef,
          className:
            'dsh-sk-row' + (hidden ? ' is-hidden' : '') + (detailOpen ? ' is-expanded' : ''),
          style: {
            '--i': String(index),
            '--vi': hidden ? '0' : String(visibleIndex),
          },
          children: [
            jsxs('div', {
              className: 'dsh-sk-row-inner',
              children: [
                jsxs('div', {
                  className: 'dsh-sk-row-pad',
                  children: [
                    jsx('span', {
                      className: 'dsh-sk-dot',
                      'data-state': dotState,
                      'aria-hidden': 'true',
                    }),
                    jsxs('div', {
                      className: 'dsh-sk-row-text',
                      children: [
                        jsxs('div', {
                          className: 'dsh-sk-name-line',
                          children: [
                            jsx('span', {
                              className: 'dsh-sk-name',
                              title: row.name,
                              children: jsx(Highlight, { text: row.name, tokens }),
                            }),
                            descOnly
                              ? jsx('span', {
                                  className: 'dsh-sk-tag-desc',
                                  children: t('skills.descMatch'),
                                })
                              : null,
                          ],
                        }),
                        jsxs('div', {
                          className: 'dsh-sk-desc',
                          title: fullMeta,
                          children: [
                            jsx('span', { className: 'dsh-sk-st', children: statusText }),
                            extra === undefined
                              ? null
                              : jsx('span', {
                                  className: 'dsh-sk-st is-warn',
                                  children: ' · ' + extra,
                                }),
                            row.description === undefined
                              ? null
                              : jsxs('span', {
                                  children: [
                                    ' · ',
                                    jsx(Highlight, { text: row.description, tokens }),
                                  ],
                                }),
                          ],
                        }),
                      ],
                    }),
                    jsxs('div', {
                      className: 'dsh-sk-row-actions',
                      children: [
                        jsx('button', {
                          type: 'button',
                          className: 'dsh-sk-btn-detail' + (detailOpen ? ' is-active' : ''),
                          'aria-expanded': detailOpen,
                          'aria-controls': 'dsh-sk-detail-' + row.name,
                          onClick: () => onToggleDetail(row),
                          children: detailOpen ? t('skills.detail.close') : t('skills.detail'),
                        }),
                        jsx(Switch, {
                          checked: !off,
                          disabled: saving,
                          title: off ? t('skills.enabled') : t('skills.disabled'),
                          label: row.name,
                          onChange: (next) => onToggle(row, next),
                        }),
                      ],
                    }),
                  ],
                }),
                jsx('div', {
                  className: 'dsh-sk-detail-wrap',
                  id: 'dsh-sk-detail-' + row.name,
                  children: jsx('div', {
                    className: 'dsh-sk-detail-overflow',
                    children: showDetail
                      ? jsx(SkillDetail, {
                          row,
                          open: detailOpen,
                          remote,
                          session,
                          t,
                          showToast,
                          tokens,
                        })
                      : null,
                  }),
                }),
              ],
            }),
          ],
        },
        row.name,
      )
    }

    /**
     * The panel's one search control: a neutral glass field, inline completion,
     * suggestions while typing, and the recent queries when it is empty.
     */
    function SearchBox({ query, onQueryChange, rows, t }) {
      const rootRef = useRef(null)
      const fieldRef = useRef(null)
      const inputRef = useRef(null)
      const popRef = useRef(null)
      const [focused, setFocused] = useState(false)
      const [suppress, setSuppress] = useState(false)
      const [activeIndex, setActiveIndex] = useState(-1)
      const [recents, setRecents] = useState(readRecents)
      const recentsRef = useRef(recents)
      recentsRef.current = recents
      const [quiet, setQuiet] = useState(false)
      const [ghost, setGhost] = useState('')
      const ghostFull = useRef('')
      const [flash, setFlash] = useState(false)
      const flashTimer = useRef(0)
      const raf = useRef(0)
      const cursor = useRef({ x: 0, y: 0 })
      const target = useRef({ x: 0, y: 0 })
      const firstMove = useRef(true)

      const trimmed = query.trim()
      const tokens = useMemo(
        () => (trimmed === '' ? [] : trimmed.toLowerCase().split(/\s+/)),
        [trimmed],
      )
      const suggestions = useMemo(() => {
        if (trimmed === '') return []
        const needle = trimmed.toLowerCase()
        return rows
          .map((row) => row.name)
          .filter((name) => name.toLowerCase() !== needle && name.toLowerCase().includes(needle))
          .filter((name, index, list) => list.indexOf(name) === index)
          .sort((a, b) => {
            const aStart = a.toLowerCase().startsWith(needle) ? 0 : 1
            const bStart = b.toLowerCase().startsWith(needle) ? 0 : 1
            return aStart - bStart || a.localeCompare(b)
          })
          .slice(0, 6)
      }, [rows, trimmed])
      const items = useMemo(
        () =>
          trimmed === ''
            ? recents.map((value) => ({ type: 'recent', value }))
            : suggestions.map((value) => ({ type: 'suggestion', value })),
        [trimmed, recents, suggestions],
      )
      const open = focused && !suppress && items.length > 0
      const hasValue = query !== ''
      const hasGhost = ghost !== ''

      const updateGhost = useCallback(() => {
        const input = inputRef.current
        let next = { full: '', rest: '' }
        if (input !== null && focused && query !== '' && !/\s/.test(query)) {
          const lower = query.toLowerCase()
          const hit = rows.find(
            (row) => row.name.toLowerCase().startsWith(lower) && row.name.length > query.length,
          )
          if (hit !== undefined && input.scrollWidth <= input.clientWidth + 1) {
            next = { full: hit.name, rest: hit.name.slice(query.length) }
          }
        }
        ghostFull.current = next.full
        setGhost(next.rest)
      }, [focused, query, rows])

      useEffect(() => {
        updateGhost()
      }, [updateGhost])

      useEffect(() => {
        if (popRef.current !== null) popRef.current.inert = !open
      }, [open])

      useEffect(() => {
        if (activeIndex < 0 || popRef.current === null) return
        const active = popRef.current.querySelector('.is-active')
        if (active !== null && typeof active.scrollIntoView === 'function') {
          active.scrollIntoView({ block: 'nearest' })
        }
      }, [activeIndex])

      useEffect(() => {
        if (activeIndex >= items.length) setActiveIndex(-1)
      }, [activeIndex, items.length])

      useEffect(() => {
        const onShortcut = (event) => {
          // A retained (but hidden) panel must not steal the host-wide `/` or
          // Ctrl/⌘K. Only the visible instance answers.
          if (
            rootRef.current === null ||
            rootRef.current.getClientRects().length === 0 ||
            rootRef.current.offsetParent === null
          ) {
            return
          }
          const targetElement = event.target
          const typing =
            targetElement instanceof HTMLElement &&
            (targetElement.tagName === 'INPUT' ||
              targetElement.tagName === 'TEXTAREA' ||
              targetElement.isContentEditable)
          const slash = event.key === '/' && !typing
          const commandK = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k'
          if (slash || commandK) {
            event.preventDefault()
            if (inputRef.current !== null) {
              inputRef.current.focus()
              inputRef.current.select()
            }
          }
        }
        document.addEventListener('keydown', onShortcut)
        return () => document.removeEventListener('keydown', onShortcut)
      }, [])

      useEffect(
        () => () => {
          clearTimeout(flashTimer.current)
          cancelAnimationFrame(raf.current)
        },
        [],
      )

      const flashCommit = () => {
        setFlash(true)
        clearTimeout(flashTimer.current)
        flashTimer.current = setTimeout(() => setFlash(false), 720)
      }

      const commitRecent = (value) => {
        const text = String(value ?? '').trim()
        if (text === '') return
        const next = [text, ...recentsRef.current.filter((item) => item !== text)].slice(
          0,
          MAX_RECENTS,
        )
        recentsRef.current = next
        setRecents(next)
        saveRecents(next)
      }

      const deleteRecent = (value) => {
        const next = recentsRef.current.filter((item) => item !== value)
        recentsRef.current = next
        setRecents(next)
        saveRecents(next)
        setQuiet(true)
      }

      const clearRecents = () => {
        recentsRef.current = []
        setRecents([])
        saveRecents([])
        setQuiet(true)
      }

      const pick = (item) => {
        if (item === undefined) return
        onQueryChange(item.value)
        commitRecent(item.value)
        setSuppress(true)
        setActiveIndex(-1)
        setQuiet(false)
        flashCommit()
        if (inputRef.current !== null) inputRef.current.focus()
      }

      const acceptGhost = () => {
        const full = ghostFull.current
        if (full === '') return
        onQueryChange(full)
        commitRecent(full)
        setSuppress(true)
        setActiveIndex(-1)
        flashCommit()
      }

      const clearQuery = () => {
        onQueryChange('')
        setSuppress(false)
        setActiveIndex(-1)
        setQuiet(false)
        if (inputRef.current !== null) inputRef.current.focus()
      }

      const handleKeyDown = (event) => {
        if (event.nativeEvent !== undefined && event.nativeEvent.isComposing === true) return
        if (event.key === 'Tab' && ghostFull.current !== '' && !event.shiftKey) {
          event.preventDefault()
          acceptGhost()
          return
        }
        if (
          event.key === 'ArrowRight' &&
          ghostFull.current !== '' &&
          inputRef.current !== null &&
          inputRef.current.selectionStart === query.length
        ) {
          event.preventDefault()
          acceptGhost()
          return
        }
        if (event.key === 'ArrowDown' && open) {
          event.preventDefault()
          setActiveIndex((index) => (items.length === 0 ? -1 : (index + 1) % items.length))
          return
        }
        if (event.key === 'ArrowUp' && open) {
          event.preventDefault()
          setActiveIndex((index) =>
            items.length === 0 ? -1 : (index - 1 + items.length) % items.length,
          )
          return
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          if (open && activeIndex >= 0 && activeIndex < items.length) {
            pick(items[activeIndex])
            return
          }
          if (query.trim() !== '') {
            commitRecent(query.trim())
            setSuppress(true)
            flashCommit()
          }
          return
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          if (query !== '') clearQuery()
          else {
            setFocused(false)
            if (inputRef.current !== null) inputRef.current.blur()
          }
        }
      }

      const handleInput = (event) => {
        onQueryChange(event.target.value)
        setSuppress(false)
        setActiveIndex(-1)
        setQuiet(false)
        const field = fieldRef.current
        if (field !== null) {
          field.classList.remove('is-pulse')
          void field.offsetWidth
          field.classList.add('is-pulse')
        }
      }

      const handleFocus = () => {
        setFocused(true)
        setSuppress(false)
        setActiveIndex(-1)
        setQuiet(false)
      }

      const handleBlur = () => {
        setFocused(false)
        setSuppress(false)
        setActiveIndex(-1)
      }

      const tick = () => {
        const root = rootRef.current
        if (root === null) return
        cursor.current.x += (target.current.x - cursor.current.x) * 0.2
        cursor.current.y += (target.current.y - cursor.current.y) * 0.2
        root.style.setProperty('--sk-mx', cursor.current.x.toFixed(1) + 'px')
        root.style.setProperty('--sk-my', cursor.current.y.toFixed(1) + 'px')
        if (
          Math.abs(target.current.x - cursor.current.x) > 0.4 ||
          Math.abs(target.current.y - cursor.current.y) > 0.4
        ) {
          raf.current = requestAnimationFrame(tick)
        } else {
          raf.current = 0
        }
      }

      const handlePointerMove = (event) => {
        const field = fieldRef.current
        if (field === null) return
        const rect = field.getBoundingClientRect()
        target.current = { x: event.clientX - rect.left, y: event.clientY - rect.top }
        if (firstMove.current) {
          cursor.current = { ...target.current }
          firstMove.current = false
        }
        if (raf.current === 0) raf.current = requestAnimationFrame(tick)
      }

      const handlePointerLeave = () => {
        const field = fieldRef.current
        if (field === null) return
        target.current = { x: field.offsetWidth / 2, y: field.offsetHeight / 2 }
        firstMove.current = true
        if (raf.current === 0) raf.current = requestAnimationFrame(tick)
      }

      const handleFieldMouseDown = (event) => {
        if (event.target === inputRef.current) return
        if (event.target instanceof Element && event.target.closest('button') !== null) return
        event.preventDefault()
        if (inputRef.current !== null) inputRef.current.focus()
      }

      const renderRecents = () => {
        if (recents.length === 0) return null
        return jsxs('div', {
          className: 'dsh-sk-pop-sec',
          children: [
            jsxs('div', {
              className: 'dsh-sk-pop-title',
              children: [
                jsx('span', { children: t('skills.search.recents') }),
                jsx('button', {
                  type: 'button',
                  onMouseDown: (event) => event.preventDefault(),
                  onClick: clearRecents,
                  children: t('skills.search.recentsClear'),
                }),
              ],
            }),
            jsx('div', {
              className: 'dsh-sk-recents',
              children: recents.map((value, index) => {
                const active = activeIndex === index
                return jsxs(
                  'div',
                  {
                    className:
                      'dsh-sk-recent-wrap' + (active ? ' is-active' : ''),
                    children: [
                      jsxs('div', {
                        className:
                          'dsh-sk-recent dsh-sk-pop-item' + (active ? ' is-active' : ''),
                        role: 'option',
                        id: 'dsh-sk-opt-' + index,
                        'aria-selected': active,
                        style: { '--i': String(index) },
                        onMouseDown: (event) => event.preventDefault(),
                        onClick: () => pick({ type: 'recent', value }),
                        children: [
                          jsx(IconClock, { size: 15 }),
                          jsx('span', { title: value, children: value }),
                        ],
                      }),
                      jsx('button', {
                        type: 'button',
                        className: 'dsh-sk-x',
                        'aria-label': t('skills.search.delete'),
                        title: t('skills.search.delete'),
                        onMouseDown: (event) => event.preventDefault(),
                        onClick: (event) => {
                          event.stopPropagation()
                          deleteRecent(value)
                        },
                        children: jsx(IconX, { size: 11 }),
                      }),
                    ],
                  },
                  value,
                )
              }),
            }),
          ],
        })
      }

      const renderSuggestions = () => {
        if (suggestions.length === 0) return null
        return jsxs('div', {
          className: 'dsh-sk-pop-sec',
          children: [
            jsx('div', {
              className: 'dsh-sk-pop-title',
              children: jsx('span', { children: t('skills.search.suggestions') }),
            }),
            jsx('div', {
              className: 'dsh-sk-suggests',
              children: suggestions.map((name, index) => {
                const active = activeIndex === index
                return jsxs(
                  'button',
                  {
                    type: 'button',
                    role: 'option',
                    id: 'dsh-sk-opt-' + index,
                    'aria-selected': active,
                    className:
                      'dsh-sk-suggestion dsh-sk-pop-item' + (active ? ' is-active' : ''),
                    style: { '--i': String(index) },
                    onMouseDown: (event) => event.preventDefault(),
                    onClick: () => pick({ type: 'suggestion', value: name }),
                    children: [
                      jsx(IconSearch, { size: 15 }),
                      jsx('span', {
                        className: 'dsh-sk-suggestion-name',
                        children: jsx(Highlight, { text: name, tokens }),
                      }),
                    ],
                  },
                  name,
                )
              }),
            }),
          ],
        })
      }

      const footer = jsxs('div', {
        className: 'dsh-sk-pop-foot',
        children: [
          jsxs('span', {
            children: [
              jsx('kbd', { className: 'dsh-sk-kbd', children: '↑' }),
              jsx('kbd', { className: 'dsh-sk-kbd', children: '↓' }),
              t('skills.search.keySelect'),
            ],
          }),
          jsxs('span', {
            children: [
              jsx('kbd', { className: 'dsh-sk-kbd', children: '↵' }),
              t('skills.search.keySearch'),
            ],
          }),
          jsxs('span', {
            children: [
              jsx('kbd', { className: 'dsh-sk-kbd', children: 'Tab' }),
              t('skills.search.keyComplete'),
            ],
          }),
          jsxs('span', {
            children: [
              jsx('kbd', { className: 'dsh-sk-kbd', children: 'Esc' }),
              t('skills.search.keyClose'),
            ],
          }),
        ],
      })

      return jsxs('div', {
        className:
          'dsh-sk-search' +
          (focused ? ' is-focus' : '') +
          (hasValue ? ' has-value' : '') +
          (hasGhost ? ' has-ghost' : '') +
          (open ? ' is-open' : '') +
          (flash ? ' is-flash' : ''),
        ref: rootRef,
        children: [
          jsxs('div', {
            className: 'dsh-sk-field' + (focused ? '' : ''),
            ref: fieldRef,
            onPointerMove: handlePointerMove,
            onPointerLeave: handlePointerLeave,
            onMouseDown: handleFieldMouseDown,
            children: [
              jsx('div', { className: 'dsh-sk-layer dsh-sk-glass', 'aria-hidden': 'true' }),
              jsx('div', { className: 'dsh-sk-layer dsh-sk-shine', 'aria-hidden': 'true' }),
              jsx('span', {
                className: 'dsh-sk-icon',
                'aria-hidden': 'true',
                children: jsx(IconSearch, { size: 22 }),
              }),
              jsxs('span', {
                className: 'dsh-sk-input-wrap',
                children: [
                  jsx('input', {
                    ref: inputRef,
                    id: 'dsh-sk-search-input',
                    name: 'dsh-sk-search',
                    className: 'dsh-sk-input',
                    type: 'text',
                    value: query,
                    placeholder: t('common.filterPlaceholder'),
                    autoComplete: 'off',
                    spellCheck: false,
                    enterKeyHint: 'search',
                    role: 'combobox',
                    'aria-expanded': open,
                    'aria-controls': 'dsh-sk-search-pop',
                    'aria-autocomplete': 'list',
                    'aria-activedescendant':
                      open && activeIndex >= 0 ? 'dsh-sk-opt-' + activeIndex : undefined,
                    'aria-label': t('common.filterPlaceholder'),
                    onChange: handleInput,
                    onKeyDown: handleKeyDown,
                    onFocus: handleFocus,
                    onBlur: handleBlur,
                    onScroll: updateGhost,
                  }),
                  jsx('span', {
                    className: 'dsh-sk-ghost',
                    'aria-hidden': 'true',
                    children: [
                      jsx('span', { children: query }),
                      jsx('b', { children: ghost }),
                    ],
                  }),
                ],
              }),
              jsxs('span', {
                className: 'dsh-sk-end',
                children: [
                  jsx('kbd', {
                    className: 'dsh-sk-kbd dsh-sk-k-idle',
                    'aria-hidden': 'true',
                    children: IS_MAC ? '⌘ K' : 'Ctrl K',
                  }),
                  jsx('kbd', {
                    className: 'dsh-sk-kbd dsh-sk-k-tab',
                    'aria-hidden': 'true',
                    children: 'Tab ⇥',
                  }),
                  jsx('button', {
                    type: 'button',
                    className: 'dsh-sk-clear',
                    'aria-label': t('common.filterClear'),
                    'aria-hidden': hasValue ? undefined : 'true',
                    tabIndex: hasValue ? 0 : -1,
                    title: t('common.filterClear'),
                    onMouseDown: (event) => event.preventDefault(),
                    onClick: clearQuery,
                    children: jsx(IconX, { size: 12 }),
                  }),
                ],
              }),
            ],
          }),
          jsxs('div', {
            className:
              'dsh-sk-pop' + (open ? ' is-open' : '') + (quiet ? ' is-quiet' : ''),
            id: 'dsh-sk-search-pop',
            role: 'listbox',
            'aria-label': trimmed === '' ? t('skills.search.recents') : t('skills.search.suggestions'),
            ref: popRef,
            children: [
              jsx('div', {
                className: 'dsh-sk-pop-scroll',
                children: trimmed === '' ? renderRecents() : renderSuggestions(),
              }),
              footer,
            ],
          }),
        ],
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

    function SkillsPanelIcon({ size }) {
      return jsx(IconSkillOutlineRegular, { size })
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

      /** Which row's detail is open. */
      const [detailName, setDetailName] = useState(undefined)
      /** The row filter; it only narrows what is drawn. */
      const [query, setQuery] = useState('')
      /** The status filter: all, on, off. */
      const [status, setStatus] = useState('all')
      /** The panel's own toast, and the refresh glyph's one-shot spin. */
      const [toast, setToast] = useState(undefined)
      const [spinning, setSpinning] = useState(false)
      const [stuck, setStuck] = useState(false)
      const pageRef = useRef(null)
      const sentinelRef = useRef(null)
      const spinTimer = useRef(0)
      const toastTimer = useRef(0)

      const showToast = useCallback((message) => {
        setToast({ message, id: Date.now() })
        clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setToast(undefined), 1900)
      }, [])

      useEffect(
        () => () => {
          clearTimeout(spinTimer.current)
          clearTimeout(toastTimer.current)
        },
        [],
      )

      const toggleDetail = useCallback((row) => {
        setDetailName((current) => (current === row.name ? undefined : row.name))
      }, [])

      // The search/filter block becomes sticky once the sentinel above it
      // leaves the page's own scroll container. The observer's root is that
      // container, not the viewport, which is what the host scrolls.
      useEffect(() => {
        const page = pageRef.current
        const sentinel = sentinelRef.current
        if (page === null || sentinel === null || typeof IntersectionObserver !== 'function') {
          return undefined
        }
        const observer = new IntersectionObserver(
          ([entry]) => {
            setStuck(!entry.isIntersecting && entry.boundingClientRect.top < 0)
          },
          { root: page, threshold: 0 },
        )
        observer.observe(sentinel)
        return () => observer.disconnect()
      }, [])

      const onRefresh = useCallback(() => {
        setSpinning(true)
        clearTimeout(spinTimer.current)
        spinTimer.current = setTimeout(() => setSpinning(false), 900)
        SkillsPanel.refreshConnectedCaches?.()
        reloadCatalog()
        showToast(t('skills.toast.refreshed'))
      }, [reloadCatalog, showToast, t])

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
            return false
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
            return true
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
            return false
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
      const tokens = useMemo(
        () => (query.trim() === '' ? NONE : query.trim().toLowerCase().split(/\s+/)),
        [query],
      )
      const queryRows = useMemo(() => {
        if (tokens.length === 0) return rows
        return rows.filter((row) => {
          const haystack = [row.name, row.description, row.whenToUse]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
          return tokens.every((token) => haystack.includes(token))
        })
      }, [rows, tokens])
      const counts = useMemo(() => {
        let on = 0
        let off = 0
        for (const row of queryRows) {
          if (disabled.includes(row.name)) off += 1
          else on += 1
        }
        return { all: queryRows.length, on, off }
      }, [queryRows, disabled])
      const visibleRows = useMemo(
        () =>
          status === 'all'
            ? queryRows
            : queryRows.filter((row) =>
                status === 'on' ? !disabled.includes(row.name) : disabled.includes(row.name),
              ),
        [queryRows, status, disabled],
      )
      const visibleSet = useMemo(
        () => new Set(visibleRows.map((row) => row.name)),
        [visibleRows],
      )
      const visibleIndexMap = useMemo(() => {
        const map = new Map()
        visibleRows.forEach((row, index) => map.set(row.name, index))
        return map
      }, [visibleRows])
      const filtered = query.trim() !== '' || status !== 'all'
      const matchTitle = (value) => {
        const pieces = t('skills.search.none').split('{q}')
        return jsxs('span', {
          children: [pieces[0], jsx('em', { children: value }), pieces[1] ?? ''],
        })
      }
      const emptyTitle =
        query.trim() !== ''
          ? matchTitle(query.trim())
          : status !== 'all'
            ? t('skills.empty.status')
            : t('skills.empty')
      const emptyBody =
        query.trim() !== ''
          ? t('skills.empty.body')
          : status !== 'all'
            ? t('skills.empty.statusBody')
            : undefined

      const shownParts = t('skills.meta.shown').split('{shown}')
      const totalParts = (shownParts[1] ?? '').split('{total}')

      return jsxs('div', {
        className: 'dsh-sk',
        ref: pageRef,
        style: { '--sk-label-width': t('skills.detail.labelWidth') },
        children: [
          jsxs('div', {
            className: 'dsh-sk-page',
            children: [
              jsxs('header', {
                className: 'dsh-sk-head',
                children: [
                  jsxs('div', {
                    className: 'dsh-sk-head-text',
                    children: [
                      jsx('h1', { className: 'dsh-sk-title', children: t('skills.title') }),
                      jsx('p', {
                        className: 'dsh-sk-sub',
                        children: `${t('skills.subtitle')} — ${scopeText}`,
                      }),
                    ],
                  }),
                  jsxs('button', {
                    type: 'button',
                    className: 'dsh-sk-refresh' + (spinning ? ' is-spinning' : ''),
                    title: t('skills.refreshHint'),
                    onClick: onRefresh,
                    disabled: request.status === 'loading',
                    children: [jsx(IconRefresh, { size: 15 }), t('skills.refresh')],
                  }),
                ],
              }),
              jsx('div', { className: 'dsh-sk-sentinel', ref: sentinelRef }),
              rows.length > 0
                ? jsxs('section', {
                    className: 'dsh-sk-zone' + (stuck ? ' is-stuck' : ''),
                    children: [
                      jsx('div', {
                        className: 'dsh-sk-zone-in',
                        children: jsx(SearchBox, {
                          query,
                          onQueryChange: setQuery,
                          rows,
                          t,
                        }),
                      }),
                      jsxs('div', {
                        className: 'dsh-sk-bar',
                        children: [
                          jsx(SegmentedFilter, {
                            value: status,
                            onChange: setStatus,
                            counts,
                            t,
                          }),
                          jsxs('div', {
                            className: 'dsh-sk-meta',
                            'aria-live': 'polite',
                            children: [
                              jsxs('span', {
                                children: [
                                  shownParts[0] ?? '',
                                  jsx('b', { children: visibleRows.length }),
                                  totalParts[0] ?? '',
                                  String(rows.length),
                                  totalParts[1] ?? '',
                                ],
                              }),
                              query.trim() === ''
                                ? null
                                : jsx('span', {
                                    className: 'dsh-sk-kw',
                                    title: query.trim(),
                                    children: query.trim(),
                                  }),
                            ],
                          }),
                        ],
                      }),
                    ],
                  })
                : null,

              request.status === 'loading' && rows.length === 0
                ? jsxs('div', {
                    className: 'dsh-sk-loading',
                    children: [
                      jsx('span', { className: 'dsh-sk-spinner' }),
                      t('common.loading'),
                    ],
                  })
                : null,
              request.status === 'error'
                ? jsx('p', {
                    className: 'dsh-sk-note is-error',
                    role: 'alert',
                    children: `${t('common.error')}: ${String(request.error)}`,
                  })
                : null,
              request.data?.catalogError
                ? jsx('p', {
                    className: 'dsh-sk-note',
                    children: request.data.catalogError,
                  })
                : null,
              holding.some((entry) => entry.expired)
                ? jsx('p', {
                    className: 'dsh-sk-note is-warning',
                    children: t('skills.unconfirmed.restoreHint'),
                  })
                : null,
              unconfirmedOff.size > 0
                ? jsx('p', {
                    className: 'dsh-sk-note is-warning',
                    children: t('skills.unconfirmed.offHint'),
                  })
                : null,
              request.status === 'ready' && namespace === undefined
                ? jsx('p', {
                    className: 'dsh-sk-note is-error',
                    children: t('skills.noNamespace'),
                  })
                : null,
              writeError === undefined
                ? null
                : jsx('p', {
                    className: 'dsh-sk-note is-error',
                    role: 'alert',
                    children: `${t('common.error')}: ${writeError}`,
                  }),

              jsxs('ul', {
                className: 'dsh-sk-list',
                children: rows.map((row, index) => {
                  const off = disabled.includes(row.name)
                  const pending = row.pending
                  const leftover = unconfirmedOff.has(row.name)
                  const visible = visibleSet.has(row.name)
                  const detailOpen = detailName === row.name
                  const extra =
                    pending === undefined
                      ? leftover
                        ? t('skills.unconfirmed')
                        : undefined
                      : pending.expired
                        ? t('skills.unconfirmed')
                        : t('skills.restoring')
                  const dotState =
                    pending === undefined
                      ? off
                        ? leftover
                          ? 'warning'
                          : 'idle'
                        : 'done'
                      : pending.expired
                        ? 'warning'
                        : 'ongoing'
                  return jsx(
                    SkillRow,
                    {
                      row,
                      index,
                      visibleIndex: visibleIndexMap.get(row.name) ?? 0,
                      hidden: !visible,
                      off,
                      detailOpen,
                      saving,
                      dotState,
                      statusText: off ? t('skills.disabled') : t('skills.enabled'),
                      extra,
                      tokens,
                      t,
                      remote,
                      session,
                      onToggleDetail: toggleDetail,
                      onToggle: (target, next) => {
                        void setDisabled(
                          next
                            ? disabled.filter((item) => item !== target.name).sort()
                            : [...disabled, target.name].sort(),
                          { name: target.name, enabled: next },
                        ).then((ok) => {
                          if (ok !== true) return
                          showToast(
                            (next
                              ? t('skills.toast.enabled')
                              : t('skills.toast.disabled')
                            ).replace('{name}', target.name),
                          )
                        })
                      },
                      showToast,
                    },
                    row.name,
                  )
                }),
              }),

              jsx(EmptyState, {
                show: request.status === 'ready' && visibleRows.length === 0,
                title: emptyTitle,
                body: emptyBody,
                actionLabel: filtered ? t('skills.empty.reset') : t('skills.refresh'),
                onAction: filtered
                  ? () => {
                      setQuery('')
                      setStatus('all')
                    }
                  : onRefresh,
              }),

              jsx('p', { className: 'dsh-sk-caveat', children: t('skills.caveat') }),
              disabled.length > 0
                ? jsx('p', {
                    className: 'dsh-sk-note dsh-sk-uninstall',
                    children: t('uninstall.panelHint').replace(
                      '{n}',
                      String(disabled.length),
                    ),
                  })
                : null,
            ],
          }),
          jsxs('div', {
            className: 'dsh-sk-toast' + (toast === undefined ? '' : ' is-show'),
            role: 'status',
            'aria-live': 'polite',
            children: [
              jsx(IconCheck, { size: 18 }),
              jsx('span', { children: toast === undefined ? '' : toast.message }),
            ],
          }),
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

      // One scoped stylesheet for the panel. It is keyed and replaced on load so
      // a hot-reloaded client does not stack three generations of the same rules.
      ctx.effect(() => {
        if (typeof document === 'undefined') return undefined
        const previous = document.querySelector('style[data-plugin="dsh-panel-skills"]')
        if (previous !== null) previous.remove()
        const style = document.createElement('style')
        style.dataset.plugin = 'dsh-panel-skills'
        style.textContent = PANEL_CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'dsh-panel-skills: panel styles')

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