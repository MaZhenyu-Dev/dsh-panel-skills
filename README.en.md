<div align="center">

<img src="assets/icon.svg" width="76" height="76" alt="dsh-panel-skills icon" />

# dsh-panel-skills

**Manage Skills in DSH: enable, disable, inspect details, and uninstall safely.**

[简体中文](README.md) · [English](README.en.md)

For **DSH (DeepSeek Harness) Desktop** · Verified on Windows · No build step

---

</div>

## Introduction

`dsh-panel-skills` is a DSH community plugin that adds a standalone Skills management panel to the sidebar.

You can do the following directly in DSH:

- enable or disable skills;
- view skill information and a `SKILL.md` excerpt;
- filter by name, description, and when to use;
- see whether changes are actually in effect;
- safely restore skills managed by the plugin before uninstalling it.

The plugin does not modify `SKILL.md`, delete skill content, or make network requests.

> This is a community plugin, not an official DeepSeek project.

## How it works

Disabling a skill is more than hiding it from the UI.

The plugin uses two mechanisms together:

1. **Registry shadowing**: a disabled skill is no longer offered to the model or the `/` menu;
2. **Directory parking**: user-level skills are moved out of DSH's scan directories.

The UI state, skill catalogue, and filesystem are therefore cross-checked against one another. When an operation is incomplete, the panel shows "Unconfirmed" instead of reporting success.

## Features

| Feature | Description |
| --- | --- |
| Skills panel | Adds a Skills entry to the Plugins section of the DSH sidebar. |
| Enable / disable | Controls whether a skill is still offered to the model and in the `/` menu. |
| Skill details | Shows the description, when to use, path, and the first 40 lines of `SKILL.md`. |
| State verification | Distinguishes "the setting changed" from "the skill actually took effect". |
| Filtering | Quickly find skills by name, description, or when to use. |
| Safe uninstall | Restores skills parked by the plugin before uninstalling; refuses to uninstall if restoration fails. |
| Chinese / English UI | Ships with Simplified Chinese and English strings. |

## Compatibility

The current version is based on and verified with:

- **DSH Desktop `0.2.1-rc.2`**
- **Windows**

As new official DSH releases ship, this project will keep tracking compatibility and update these notes.

The code uses cross-platform Node.js APIs; macOS / Linux have not yet been tested in practice.

> Compatibility is defined by the current version notes in this repository.

## Installation

### Prerequisites

- DSH Desktop is installed;
- DSH's **Plugins** management is available;
- The plugin is currently installed from a source directory.

### Install from source

```powershell
git clone https://github.com/MaZhenyu-Dev/dsh-panel-skills.git
cd dsh-panel-skills
npm install --omit=dev --legacy-peer-deps --no-package-lock
```

Then:

1. Open DSH → **Plugins**;
2. Choose to install a plugin;
3. Enter the absolute path of the project directory:

```text
link:C:\Users\<you>\dsh-panel-skills
```

4. Enable `dsh-panel-skills`;
5. Reload the DSH page;
6. Once **Skills** appears in the **Plugins** section of the sidebar, installation is complete.

`@deepseek-ai/cordis` is provided by the DSH host and does not need to be installed separately.

### Skills does not appear after installation

Check:

- whether the plugin is enabled;
- whether the DSH page was reloaded;
- whether the current DSH version matches the compatibility notes.

## Usage

### Open the panel

Sidebar → **Plugins** → **Skills**.

### Enable / disable

After disabling a skill:

- user-level skills are moved to the plugin's dedicated parking directory;
- the skill is removed from the model and the `/` menu;
- the skill's original content is not modified or deleted.

When re-enabled, the plugin restores the directory to its original location based on the record.

### States

| State | Meaning |
| --- | --- |
| **Enabled** | The skill appears normally in the current catalogue. |
| **Disabled** | The skill is on the disabled list, and the current catalogue no longer offers it. |
| **Restoring…** | Waiting for the directory and catalogue to be restored. |
| **Unconfirmed** | The configured state and the actual skill catalogue disagree; investigation is needed. |

### Details

Click **Details** to see a skill's description, when to use, invocation state, path, and the first 40 lines of `SKILL.md`.

If a skill has no file path (for example, a bundled skill), the panel says so explicitly.

### Filter

Type a name, description, or when-to-use phrase to filter skills.

## Safe uninstall

The safe uninstall entry is on the **Plugins → dsh-panel-skills** detail page, alongside the official **Uninstall** button; it appears only when at least one skill is actually disabled. The bottom of the Skills panel keeps just a one-line note instead of a second button.

Before uninstalling, the plugin:

1. asks the host to prepare for uninstall;
2. restores every skill parked by this plugin, following the records;
3. confirms that all of them were restored successfully;
4. finally removes the plugin through the Plugin Manager.

If even one directory cannot be restored, the uninstall is refused, and the blocking path is named in the button's tooltip.

Using the official **Uninstall** button directly is also possible, but it cannot refuse before deleting: when the host disables or uninstalls the plugin, it schedules a 20-second fallback restore; on normal process exit, the exit guard also performs one synchronous restore when "the plugin is disabled or its dependency has been removed". If the fallback fails, the directories stay in the parking area, and the reason is written to `restore-report.json`.

> **Do not uninstall directly after disabling.** Re-enable this plugin first, then use **Uninstall safely…** on the details page; alternatively, wait 20 seconds after disabling for the fallback restore to finish. If DSH has been restarted while the plugin was disabled, this plugin will not load on the next start, and no code will be left to perform the restore.
>
> Directly deleting the plugin directory is not recommended. Before manual intervention, check `$DSH_HOME/.dsh-panel-skills-disabled/`.

## Data and safety

By default, disabled user-level skills are parked under:

```text
$DSH_HOME/.dsh-panel-skills-disabled/
├── skills/<name>/          # Skill content
├── records/<name>.json     # Restore record
├── manifest.json           # Index
└── restore-report.json     # Created when restoration fails
```

Default user skill roots:

```text
$DSH_HOME/skills
$DSH_AGENTS_HOME/skills
```

The plugin follows these principles:

- record first, then move;
- restore only from existing records; never guess paths;
- recover from interrupted operations;
- report unknown directories without moving or deleting them;
- a failure on one skill does not affect the others;
- use `rename` only; never copy, overwrite, or delete skill content.

## Configuration

Configuration namespace: `dsh-panel-skills`

| Option | Default | Description |
| --- | --- | --- |
| `disabledSkills` | `[]` | List of disabled skills. |
| `shadowSyncIntervalMs` | `1000` | State reconciliation interval; minimum 100 ms. |
| `diagnosticPath` | `""` | Optional diagnostic JSON path. |
| `disposeGraceMs` | `20000` | Restore grace period after the host exits. |

No manual configuration is normally required.

To investigate host-side issues, configure:

```yaml
- id: dsh-panel-skills
  name: dsh-panel-skills
  config:
    disabledSkills: []
    diagnosticPath: C:\temp\dsh-panel-skills.json
```

## Limitations

- Only user-level skill directories are actually moved; workspace, custom-path, and bundled skills may take effect through shadowing only.
- Preset scopes must be registered one by one; if the host cannot access a scope, the reason is recorded.
- By default, the panel shows the workspace of the most recently updated session that has a `cwd`.
- Open conversations may cache an old `/` skill list; start a new conversation or re-fetch it when necessary.
- Disabling a skill does not clear context the model has already received.
- Safe uninstall handles only directories managed by this plugin.
- Verified on Windows; macOS / Linux are untested.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| No Skills entry | Confirm the plugin is enabled, reload the page, and check the DSH version. |
| Skill still appears in the `/` menu after disabling | Start a new conversation or re-fetch the skill list. |
| Always shows "Unconfirmed" | Check `errors`, `parked`, and `roots` in the diagnostics. |
| Safe uninstall is unavailable | Resolve the directory or record blocking the safe uninstall, using the blocker shown in the message. |
| Skill is missing after disabling | Check `.dsh-panel-skills-disabled/skills/` and `records/`. |
| Disabling across volumes fails | Make sure the source directory and the parking directory are on the same volume. |

Client errors are printed to the browser console with a `[dsh-panel-skills]` prefix.

## Development

The project has no build step:

```text
dsh-panel-skills/
├── package.json
├── cordis.patch.yml
├── assets/icon.svg
├── README.md
├── README.en.md
├── CHANGELOG.md
└── lib/
    ├── index.js          # Host side
    ├── client.js         # Client side
    └── panel-rows.js     # Profile config read/write
```

- After editing `lib/index.js`, the host side hot-loads per profile;
- After editing `lib/client.js`, simply reload the DSH page;
- For changes that move directories, focus testing on interrupted operations, an existing target, cross-volume cases, and multiple profiles.

## FAQ

**Does disabling a skill delete files?**

No. User-level skills are only moved to the parking directory; their content is not modified or deleted.

**Can skills be restored after deleting the plugin directory?**

The parking directory and restore records are usually preserved. After reinstalling the plugin, restoration can continue, or you can handle them manually based on the records.

**Why can some skills not be disabled?**

It may depend on the skill's directory, layer, or preset scope. The plugin will not force-move a skill outside the user-level roots; the specific reason can be confirmed through the state and diagnostics.

**Does it support multiple DSH profiles?**

Yes. Parking records include profile ownership information, so different profiles never restore each other's records.

**Why are both a host side and a client side needed?**

The client side handles the panel and configuration interaction; the host side handles skill shadowing, directory moves, and safe uninstall. Together they keep state consistent.

---

## License

This is a community plugin. The DSH / DeepSeek Harness names and trademarks belong to their respective owners.
