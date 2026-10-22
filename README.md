<div align="center">

<img src="assets/icon.svg" width="76" height="76" alt="dsh-panel-skills 图标" />

# dsh-panel-skills

**在 DSH 中管理 Skills：启用、关闭、查看详情与安全卸载。**

[简体中文](README.md) · [English](README.en.md)

适用于 **DSH（DeepSeek Harness）桌面版** · Windows 已验证 · 无需构建

---

</div>

## 简介

`dsh-panel-skills` 是一个 DSH 社区插件，为侧边栏提供独立的 Skills 管理面板。

你可以直接在 DSH 中：

- 启用或关闭 Skills；
- 查看 Skill 信息及 `SKILL.md` 摘要；
- 按名称、描述和使用场景筛选；
- 查看实际生效状态；
- 在卸载插件前安全恢复由插件管理的 Skills。

插件不修改 `SKILL.md`，不删除 Skill 内容，也不发起网络请求。

> 本项目为社区插件，并非 DeepSeek 官方项目。

## 工作方式

Skill 关闭并不只是从界面隐藏。

插件同时使用：

1. **注册表遮蔽**：让已关闭 Skill 不再提供给模型和 `/` 菜单；
2. **目录停放**：将用户级 Skill 移出 DSH 的扫描目录。

因此，UI 状态、Skill 清单和文件系统状态会相互核对。操作未完成时，面板会显示「未确认」，而不是直接显示成功。

## 功能

| 功能 | 说明 |
| --- | --- |
| Skills 面板 | 在 DSH 侧边栏「插件」区域提供 Skills 入口。 |
| 启用 / 关闭 | 控制 Skill 是否继续出现在模型和 `/` 菜单中。 |
| Skill 详情 | 查看描述、使用场景、路径及 `SKILL.md` 前 40 行。 |
| 状态核对 | 区分“设置已修改”和“Skill 已实际生效”。 |
| 筛选 | 按名称、描述、使用场景快速查找。 |
| 安全卸载 | 卸载前恢复插件停放的 Skill；恢复失败则拒绝卸载。 |
| 中英文界面 | 提供简体中文 / English 文案。 |

## 兼容性

当前版本基于并已验证：

- **DSH 桌面版 `0.2.1-rc.2`**
- **Windows**

后续 DSH 官方发布新版本后，本项目会持续跟进适配并更新兼容性说明。

代码使用 Node.js 跨平台 API，macOS / Linux 暂未进行实际验证。

> 兼容性以仓库当前版本说明为准。

## 安装

### 前置条件

- 已安装 DSH 桌面版；
- 可以使用 DSH 的「插件」管理功能；
- 当前通过源码目录安装。

### 从源码安装

```powershell
git clone https://github.com/MaZhenyu-Dev/dsh-panel-skills.git
cd dsh-panel-skills
npm install --omit=dev --legacy-peer-deps --no-package-lock
```

然后：

1. 打开 DSH →「插件」管理；
2. 选择安装插件；
3. 输入项目目录的绝对路径：

```text
link:C:\Users\<you>\dsh-panel-skills
```

4. 启用 `dsh-panel-skills`；
5. 刷新 DSH 页面；
6. 侧边栏「插件」区域出现 **Skills** 即安装完成。

`@deepseek-ai/cordis` 由 DSH 宿主提供，无需单独安装。

### 安装后没有出现 Skills

检查：

- 插件是否已启用；
- 是否刷新了 DSH 页面；
- 当前 DSH 版本是否与兼容性说明一致。

## 使用

### 打开面板

侧边栏 →「插件」→ **Skills**。

### 启用 / 关闭

关闭 Skill 后：

- 用户级 Skill 会移动到插件专用停放目录；
- Skill 从模型和 `/` 菜单中移除；
- Skill 原始内容不会被修改或删除。

重新启用后，插件会根据记录将目录恢复到原位置。

### 状态

| 状态 | 含义 |
| --- | --- |
| **已启用** | Skill 已正常出现在当前清单中。 |
| **已关闭** | Skill 已加入关闭名单，且当前清单不再提供。 |
| **恢复中…** | 正在等待目录和清单恢复。 |
| **未确认** | 设置状态与实际 Skill 清单不一致，需要检查。 |

### 查看详情

点击「详情」可以查看 Skill 的描述、使用场景、调用状态、路径，以及 `SKILL.md` 前 40 行。

如果 Skill 没有文件路径（例如内嵌 Skill），面板会明确说明。

### 筛选

输入名称、描述或使用场景即可过滤 Skills。

## 安全卸载

安全卸载入口在 **「插件 → dsh-panel-skills」的详情页**，和官方「卸载」按钮并排；只有当前确实有被关闭的 Skill 时才会出现。Skills 面板底部只留一行提示，不再放第二个按钮。

卸载前，插件会：

1. 请求宿主准备卸载；
2. 按记录恢复由本插件停放的 Skills；
3. 确认全部恢复成功；
4. 最后通过插件管理器移除插件。

只要存在无法恢复的目录，卸载就会被拒绝，并在按钮的提示里给出挡住的路径。

直接使用官方「卸载」也可以，但它无法在删除前拒绝：宿主在停用或卸载时会排一个 20 秒的兜底还原；进程正常退出时，退出守卫还会在“插件已停用或依赖已移除”时同步还原一次。若兜底失败，目录仍留在停放区，原因写入 `restore-report.json`。

> **停用后不要直接卸载。** 先重新启用本插件，再用详情页的「安全卸载」；或者停用后等 20 秒，让兜底还原完成。停用后如果重启过 DSH，下一次启动时本插件不会加载，也就没有代码能再执行还原。
>
> 不建议直接删除插件目录。手动处理前，请先检查 `$DSH_HOME/.dsh-panel-skills-disabled/`。

## 数据与安全

用户级 Skill 关闭后默认停放在：

```text
$DSH_HOME/.dsh-panel-skills-disabled/
├── skills/<name>/          # Skill 内容
├── records/<name>.json     # 恢复记录
├── manifest.json           # 索引
└── restore-report.json     # 恢复异常时生成
```

默认用户 Skill 根目录：

```text
$DSH_HOME/skills
$DSH_AGENTS_HOME/skills
```

插件遵循以下原则：

- 先记录，再移动；
- 恢复只依据已有记录，不猜测路径；
- 支持异常中断后的恢复；
- 未知目录只报告，不擅自移动或删除；
- 单个 Skill 操作失败不会影响其他 Skill；
- 只执行 `rename`，不复制、覆盖或删除 Skill 内容。

## 配置

配置命名空间：`dsh-panel-skills`

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `disabledSkills` | `[]` | 已关闭 Skill 列表。 |
| `shadowSyncIntervalMs` | `1000` | 状态对账周期，最小 100 ms。 |
| `diagnosticPath` | `""` | 可选诊断 JSON 路径。 |
| `disposeGraceMs` | `20000` | 宿主退出后的恢复等待时间。 |

通常无需手动修改配置。

需要排查宿主侧问题时，可配置：

```yaml
- id: dsh-panel-skills
  name: dsh-panel-skills
  config:
    disabledSkills: []
    diagnosticPath: C:\temp\dsh-panel-skills.json
```

## 限制

- 只有用户级 Skill 目录会被实际移动；工作区、自定义路径和内嵌 Skill 可能仅通过遮蔽生效。
- preset scope 需要逐个注册；宿主无法访问某个 scope 时，会记录原因。
- 面板默认显示最近一次更新且带 `cwd` 的会话所属工作区。
- 已打开的对话可能缓存旧的 `/` Skill 清单，必要时请新开对话或重新拉取。
- 关闭 Skill 不会清除模型此前已经获得的上下文。
- 安全卸载只处理本插件管理的目录。
- Windows 已验证；macOS / Linux 暂未验证。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 没有 Skills 入口 | 确认插件已启用、刷新页面，并检查 DSH 版本。 |
| 关闭后仍出现在 `/` 菜单 | 新开对话或重新拉取 Skill 清单。 |
| 一直显示「未确认」 | 检查诊断信息中的 `errors`、`parked`、`roots`。 |
| 无法安全卸载 | 根据安全卸载提示的阻塞项处理目录或记录。 |
| 关闭后找不到 Skill | 检查 `.dsh-panel-skills-disabled/skills/` 和 `records/`。 |
| 跨卷关闭失败 | 确保源目录和停放目录位于同一卷。 |

客户端错误会以 `[dsh-panel-skills]` 前缀输出到浏览器控制台。

## 开发

项目没有构建步骤：

```text
dsh-panel-skills/
├── package.json
├── cordis.patch.yml
├── assets/icon.svg
├── README.md
├── README.en.md
├── CHANGELOG.md
└── lib/
    ├── index.js          # 宿主侧
    ├── client.js         # 客户端
    └── panel-rows.js     # profile 配置读写
```

- 修改 `lib/index.js` 后，宿主侧会按 profile 热加载；
- 修改 `lib/client.js` 后，刷新 DSH 页面即可；
- 涉及目录移动的改动，应重点验证异常中断、目标已存在、跨卷和多 profile 场景。

## FAQ

**关闭 Skill 会删除文件吗？**

不会。用户级 Skill 只是被移动到停放目录，内容不会被修改或删除。

**直接删除插件目录还能恢复吗？**

停放目录和恢复记录通常仍会保留。重新安装插件后可以继续恢复，也可以根据记录手动处理。

**为什么有些 Skill 无法关闭？**

可能与 Skill 所在目录、层或 preset scope 有关。插件不会强行移动不属于用户级根目录的 Skill，具体原因可通过状态和诊断信息确认。

**支持多个 DSH profile 吗？**

支持。停放记录包含 profile 归属信息，不同 profile 不会互相恢复对方的记录。

**为什么需要宿主侧和客户端两部分？**

客户端负责面板与配置交互；宿主侧负责 Skill 遮蔽、目录移动和安全卸载，两部分共同保证状态一致。

---

## License

本项目为社区插件。DSH / DeepSeek Harness 的名称与商标归其各自所有者。
