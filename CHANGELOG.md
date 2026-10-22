# Changelog — dsh-panel-skills

All notable changes to this package. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The package is one half of the former `dsh-plugin-mcp-skills` monolith. Its
version starts at 0.1.0; the split point is the monolith's 0.5.0.

## [0.1.1] — 2026-10-22

### Changed

- **One refresh button.** The header refresh now also emits the client-wide
  `connection/reset` that the inline "re-fetch now" button used to send, so one
  click re-reads the panel and makes the built-in `/` menu drop its
  per-conversation catalog cache. The always-visible hint sentence and its second
  button are gone; the explanation moved to the button's tooltip.

## [0.1.0] — 2026-10-22

Extracted from `dsh-plugin-mcp-skills` 0.5.0. This package is the only owner of
the parked-skill area and of the code that can put those directories back.

### Added

- **Host half** (`lib/index.js`): the rank-1 shadow provider, the parked-skill
  records/manifest (record-before-move, crash resume, record-only restore,
  per-profile ownership, per-entry isolation), the opt-in `diagnosticPath`
  document with layer information, the disposal grace that restores parked
  skills when no replacement instance applies, and the safe-uninstall
  preparation that refuses rather than strands a directory.
- **Browser half** (`lib/client.js`): the `skills` sidebar panel (order 2) with
  the switch, the restore window, "unconfirmed" states, the SKILL.md detail
  view, the catalog refresh and the filter — plus the safe-uninstall control on
  this plugin's detail page, because this package owns the data an uninstall can
  lose.
- Per-package `lib/panel-rows.js` with its own backup suffix
  (`bak-dsh-panel-skills`) and per-package `cordis.patch.yml`.
- A one-time adoption of the pre-split parked root: `.mcp-skills-panel-disabled`
  is renamed to `.dsh-panel-skills-disabled` when the new root does not exist;
  a refused rename is reported and the old directory is left untouched.
- **Plugin icon** (`assets/icon.svg`), declared through the manifest's top-level
  `icon` field and shipped by `files`. The plugin manager renders it as this
  package's artwork instead of the built-in default; `readPluginMeta` inlines
  the file as a base64 data URL. Rules and swap steps:
  [README](README.md#图标).

### Changed

- Profile entry id and settings namespace are `dsh-panel-skills`.
- The parked root is `$DSH_HOME/.dsh-panel-skills-disabled`.
- The shadow provider name is `dsh-panel-skills-shadow`.
- The safe-uninstall UI reads and writes the `uninstall.*` dictionary keys.
- **Safe uninstall moved to the plugin's own detail page.** It registers through
  the official `plugins.detail.actions` slot, appears only while a switched-off
  skill is waiting to be restored, and sits beside the official Uninstall
  button. The Skills panel keeps only a one-line pointer. The official button
  itself cannot be replaced or hidden, so a page with no switched-off skill still
  shows exactly one button.
- **Process-exit restore guard.** If the app quits before the 20 s disposal
  grace fires, the host restores synchronously when the bundle is no longer
  selected or the package is gone. This covers uninstall-then-quit and
  disable-then-quit; a plugin that was already disabled when DSH restarted, and
  whose host half therefore never loaded, remains a manual-recovery case.
- The derived parked-skill index is no longer rewritten when a restore leaves it
  unchanged, so the exit guard can run without a pointless disk write.

### Removed

- `mcpSnapshot`, `mcpEditRequest`, `mcpEditResult` and the MCP snapshot block of
  the diagnostic. This package does not touch `configEditor`.
