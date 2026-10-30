# dsh-session-purge

[English](README.en.md) | 简体中文

> [!IMPORTANT]
> 社区第三方插件，与 DeepSeek 官方无隶属关系；触点均为 Harness 内部实现面（非文档化 API）。
> 兼容基线：`@deepseek-ai/dsh-desktop` **0.2.1-rc.5**（Windows x64，nightly 渠道；rc.3 于 2026-10-26 逐触点审计，rc.5 于 2026-10-30 复核）。nightly 更新可能**静默破坏兼容**——升级 DSH 后先运行 `node --test test/purge.test.mjs`（应 35/35）。

> [!WARNING]
> **删除即永久，无回收站**；脱敏只改写本地日志文件，**不能替代密钥轮换**。

管理 DeepSeek Harness 会话数据的两个操作：

- **永久删除**：磁盘日志 + 投影缓存 + 工作区记账 + 工具输出临时文件，级联清除全部子代理会话；
- **原地脱敏**：把敏感值（完整值/前缀）掩码写入会话 zstd 日志，保留历史，帧结构不变。

## 入口

| 入口 | 位置 |
|---|---|
| 设置 → **会话清理** | 按工作区分组的会话列表：单会话删除（行内两段确认，Enter/Esc/10 秒撤防）、脱敏对话框、「删除工作区」（组头按钮，两段确认；成员运行中整体 409 拒绝；部分失败保留工作区并逐条报告）、搜索与"仅磁盘残留"筛选 |
| 会话行"…"菜单 | 末尾「删除」项（官方槽位 `sidebar.workspaces.session.menu.item`），删除该行会话且不切换当前对话 |

完成对话框报告释放字节、级联数与临时清扫摘要；对话框配色全部取宿主主题 token，跟随深浅色。

## 页面布局重置

客户端无内置入口；「会话清理」面板底部提供指令（F12 → Console 粘贴执行；重载后空白则手动重启客户端）：

```js
['dsh.sidebar-right.v1','dsh.sidebar-browser.v1','dsh.workspace.view.v5','dsh.conversation.contentWidth','dsh.trajectory'].forEach(p=>Object.keys(localStorage).filter(k=>k.startsWith(p)).forEach(k=>localStorage.removeItem(k)));
location.reload();
```

只清布局白名单（前缀匹配覆盖按会话键），不动快捷键、草稿、终端与计划任务。备选：更宽 `localStorage.clear()`；更严（精确边界 + 旧启动标记键）：

```js
['dsh.sidebar-right.v1','dsh.sidebar-browser.v1','dsh.workspace.view.v5','dsh.conversation.contentWidth','dsh.trajectory.duration','dsh.trajectory.jsonStringWrapping','dsh.session-purge.reset-layout-on-boot'].forEach((p)=>Object.keys(localStorage).filter((k)=>k===p||k.startsWith(p+'.')).forEach((k)=>localStorage.removeItem(k)));location.reload()
```

## 删除语义

```
ctx.get('sessions')                              → 活会话：flush（驻留对象在无代理持有时再驱逐）
ctx.get('storageDomain') → 'session_projcache'   → 投影缓存行（域 + 文件双层）
ctx.get('storageDomain') → 'workspace'           → 工作区记账 + 归档/置顶集合（域 + 文件双层）
$DSH_HOME/sessions/<projectKey>/<id>/            → 磁盘日志目录
%TEMP%/dsh-{subprocess,spill,acl-skill,...}-*    → 内容提及该会话 id 的工具输出目录（归因清扫）
header.parentSession === id                      → 子代理级联
ctx.emit('api-session/removed')                  → 通知全部客户端刷新
```

- 顺序：先删日志并验证删净，再清记账（半删会话不会掉出分组）；清理后逐层事后验证，未净显式报错，可直接重试；
- 工作区记录另走 harness 的 `workspaceRegistry.delete()`（pendingMutation 协议，进程在删除过程中退出也能在下次启动收尾）；无该服务时降级路径写同样的标记，记录删除失败会回滚 order；
- 护栏：会话 id 须匹配 `session-<uuid>`（或裸 uuid，不区分大小写）；**运行中拒绝（409）**；级联深度上限 `MAX_CASCADE_DEPTH = 8`，超出以 `cascadeTruncated: true` 显式报告；仅驻留不拒绝（先 `flush` 再清盘）；路径必须落在预期根内；**符号链接一律拒删**；全走 Node `fs`，不经 shell；
- TEMP 清扫按**内容归因**（目录内容提及会话 id 才删），受文件数/字节预算约束（超限报 `budgetHit`）；整棵级联只扫一次，各会话 `tempSweep[].dirs` 之和可能大于实际删除数（客户端摘要用去重合计 `tempSweepTotal`）。

## 脱敏语义

逐帧解压 → 替换 → 逐帧重压缩，帧数与行结构不变；写回前落备份、写回后完整校验（内容一致 + 敏感值绝迹 + 帧数一致），失败自动回滚；**成功即删备份**。备份清理失败不回滚（避免把脱敏结果还原成明文），报告 `backupResidual`/`backupError`；单文件失败不中断其余文件。

- `secrets`：完整值（6–512 字符，至多 64 项）→ 掩码 `[REDACTED:xxxx…lenNN]`（保留前 4 位与总长）；6–8 位短值会泄露大半，建议改用 `prefixes` 或直接轮换；
- `prefixes`：已知前缀（4–32 位 `[A-Za-z0-9_-]`，至多 64 项），保留前缀、清除其后连续的字母/数字/`_`/`-`；
- 仅"运行中"拒绝（409）；请勿对**当前正查看**的会话执行（界面状态未验证）；
- 需 Node ≥ 23.8 的 zstd API（运行时检测；不满足时该路由 501，其余功能不受影响）。

## 目录结构与接口

```
dsh-session-purge/
├── package.json          # 包清单：dsh.bundle.patch + dsh.client 声明
├── cordis.patch.yml      # bundle 层：向 profile 插入插件行
├── lib/index.js          # 宿主半：删除/脱敏管线 + 三个同源 HTTP 路由
├── lib/client.js         # 客户端半：对话框 / 设置面板 / 侧栏行菜单
└── test/purge.test.mjs   # 单元测试（假 ctx + 临时 DSH home）
```

信任模型与宿主 `api-request-trust` 一致：授权主体必须为 loopback；`sec-fetch-site: cross-site` 一律拒绝；`Origin` 存在时必须等于该主体（桌面端经 `dsh-app://` 转发会剥离 Origin，故缺失即放行）。

```
GET  /_dsh/session-purge/list             → { ok, sessions: [...] }（行含 workspaceId / workspace）
POST /_dsh/session-purge/delete           → { sessionId } → { ok, deleted[], freedBytes, projRows, wsRefs, tempSweep[], tempSweepTotal, live[], descendants[], cascadeTruncated }
POST /_dsh/session-purge/delete-workspace → { workspaceId } → { ok, workspaceId, workspaceTitle, deleted[], failures[], freedBytes, projRows, wsRefs, tempSweep[], tempSweepTotal, workspaceRecordDeleted, cascadeTruncated }
POST /_dsh/session-purge/redact           → { sessionId, secrets?, prefixes? } → { ok, files[], totalReplacements, backupsResidual, failures }
```

## 安装（会修改 DSH profile）

克隆或下载本仓库（无 npm 依赖），然后**二选一**：把 `dsh-session-purge` 放入 profile 的 bundles 列表，或在目标 profile 的 `cordis.patch.yml` 中 `insert` 一行 `name: 'dsh-session-purge'`。二者都做会加载两次。桌面版实测无需重启（`dsh-hmr` 热加载插件行）。

## 测试

```powershell
node --test test/purge.test.mjs
```

当前 **35/35**（Node 24.21；无 zstd 的运行时跳过脱敏用例）。

## 已知限制（如实）

- **无回收站**；不回收 `attachments` 引用计数；
- TEMP 清扫是内容归因：从未提及会话 id 的输出会留存；
- **删除当前正查看的会话宿主不拦**（无窗口守卫），其后界面表现未经端到端验证；
- 子代理不在面板列出（清理依赖主会话级联）；对话页的子代理家族条目是父日志的派生投影，删除后界面残留到重建（磁盘与记账已净）；孤儿子代理需手工清理；
- 驻留会话删除后：宿主仍持代理对象则保守跳过，幽灵行留到下次重启；
- Electron 渲染缓存可能短期保留已渲染内容（推断，未端到端验证）；
- 端到端验证：0.2.0-rc.2 真机验证三个路由与两个入口；0.2.1-rc.3 起为逐触点静态审计（2026-10-26，未重复端到端）；脱敏路由与"运行中拒绝"等守卫尚未在真实数据上触发过。

变更历史见 [CHANGELOG.md](CHANGELOG.md)（自 0.3.4 起记录）。
