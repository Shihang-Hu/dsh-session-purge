# dsh-session-purge

[English](README.en.md) | 简体中文

> [!IMPORTANT]
> 社区第三方插件，与 DeepSeek 官方无隶属关系；触点均为 Harness 内部实现面（非文档化 API）。
> 兼容基线：`@deepseek-ai/dsh-desktop` **0.2.2-rc.2**（Windows x64，nightly 渠道；0.2.1-rc.3/rc.5 于 2026-10-26/30 逐触点审计；0.2.2-rc.2 于 2026-11-12 复核 `sessionQuery`/`connection.fetch` 触点，删除/脱敏未在真机重跑）。nightly 更新可能**静默破坏兼容**——升级 DSH 后先运行 `node --test test/purge.test.mjs`（应 48/48）。

> [!WARNING]
> **删除即永久，无回收站**；脱敏只改写本地日志文件，**不能替代密钥轮换**。

管理 DeepSeek Harness 会话数据的两个操作：

- **永久删除**：磁盘日志 + 投影缓存 + 工作区记账 + 工具输出临时文件，级联清除全部子代理会话；
- **原地脱敏**：把敏感值（完整值/前缀）掩码写入会话 zstd 日志，保留历史，帧结构不变。

## 入口

| 入口 | 位置 |
|---|---|
| 设置 → **会话清理** | 按工作区分组的会话列表，组头默认全部收起（搜索时自动展开）；单会话删除（同一位置点击两次确认，Esc/10 秒撤防）、脱敏对话框、「删除工作区」（组头固定位置两次点击；成员运行中整体 409 拒绝；部分失败保留工作区并逐条报告）、搜索与"仅缓存记账"筛选；无 header 的纯磁盘目录也会列出（标记「仅磁盘日志」）。上次删除后残留的缓存记账会在下次打开面板时自动收尾，不再需要第二次手动删除 |

面板顶部有「会话清理」标题、单行说明与分隔线。状态颜色：红=删除/armed，蓝=运行中，琥珀=仅缓存/仅磁盘残留，灰=归档/驻留/元信息。会话行操作区提供独立的「复制 ID」按钮（成功后原地显示「已复制」），删除按钮固定在最右。删除结果在列表上方以通知显示（释放字节、级联数、临时清扫摘要、驻留提示）；脱敏完成视图列出帧数与替换数。脱敏对话框配色全部取宿主主题 token，跟随深浅色。

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
ctx.get('sessionQuery').listSessions()           → 会话/驻留/子代理图的统一 live-preferred 枚举（无该服务时回退公开 store + persistence）
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
- 护栏：会话 id 须匹配 `session-<uuid>`、裸 uuid 或桥接 id（不区分大小写）；**运行中拒绝（409）**；级联深度上限 `MAX_CASCADE_DEPTH = 8`，超出以 `cascadeTruncated: true` 显式报告；仅驻留不拒绝（先 `flush` 再清盘）；路径必须落在预期根内；**符号链接一律拒删**；全走 Node `fs`，不经 shell；
- 布局护栏：删除/脱敏前用宿主 `sessionPersistence.stat().location` 交叉核对日志位置；位置落在 `$DSH_HOME/sessions/` 之外、或不在待删目录内时以 **503 拒绝**（fail-closed，避免"清掉账目/改写旧文件但真实日志还在"）；无该 API 的老宿主跳过这项检查；
- 目标不存在时仍幂等：session 返回 `ok` 并在报告里带 `existed: false`（客户端提示"原本已不存在"）；workspace 的 `workspaceRecordDeleted` 为 `false`，不会谎称删掉了记录；
- 纯磁盘残留：目录存在但 header 与投影行都缺失的会话也会出现在列表（`headered: false`，客户端标记「仅磁盘日志」），可单独删除；其子代理归属无法判断；
- **延迟残留自动收尾**：每次成功删除（含级联/工作区成员）会把 id 记入 `$DSH_HOME/storages/dsh-session-purge/tombstones.json`。下次插件实例的第一次 `/list` 会先对这些 id 重跑删除管线——正是宿主在退出时补写投影缓存行之后。用 `deletedAt < 本实例启动时间` 做进程栅栏：本次进程里刚删除的 id 不会被自己回收，避免与随后 shutdown 的补写竞争。全部收尾后自动移除 tombstone 文件（同进程新删除的记录会保留到下次启动）。**0.5.23 之前成功删除的历史残留没有 tombstone，升级后仍需手动清一次**；
- `live[]` 每项为 `{ sessionId, flushed, evicted, existed }`：`flushed: true && evicted: false` 表示宿主仍驻留该会话，客户端会提示彻底消失需重启；
- TEMP 清扫按**内容归因**（目录内容提及会话 id 才删），受文件数/字节预算约束（超限报 `budgetHit`）；整棵级联只扫一次，各会话 `tempSweep[].dirs` 之和可能大于实际删除数（客户端摘要用去重合计 `tempSweepTotal`）。

## 脱敏语义

逐帧解压 → 替换 → 逐帧重压缩，帧数与行结构不变；写回前落备份、写回后完整校验（内容一致 + 敏感值绝迹 + 帧数一致），失败自动回滚；**成功即删备份**。备份清理失败不回滚（避免把脱敏结果还原成明文）；报告 `backupResidual`/`backupError`，完成对话框也会列出未删除的备份路径；单文件失败不中断其余文件。

- `secrets`：完整值（6–512 字符，至多 64 项）→ 掩码 `[REDACTED:xxxx…lenNN]`（保留前 4 位与总长）；6–8 位短值会泄露大半，建议改用 `prefixes` 或直接轮换；
- `prefixes`：已知前缀（4–32 位 `[A-Za-z0-9_-]`，至多 64 项），保留前缀、清除其后连续的字母/数字/`_`/`-`；
- 仅"运行中"拒绝（409）；请勿对**当前正查看**的会话执行（界面状态未验证）；
- 依赖 Node ≥ 24.9 的 zstd API（DSH 0.2.2 基线；脱敏不再做运行时降级）。

## 目录结构与接口

```
dsh-session-purge/
├── package.json          # 包清单：dsh.bundle.patch + dsh.client 声明
├── cordis.patch.yml      # bundle 层：向 profile 插入插件行
├── lib/index.js          # 宿主半：删除/脱敏管线 + 四个认证 Fetch 路由
├── lib/client.js         # 客户端半：设置面板 / 脱敏对话框
└── test/purge.test.mjs   # 单元测试（假 ctx + 临时 DSH home）
```

四个路由注册在 `ctx.connection.fetch`，由 DSH 统一执行 Host/Origin 校验、浏览器/API Peer 认证，并且只允许 owner Peer 调用；插件不再维护自己的 loopback/Origin 判断。

```
GET  /api/session-purge/list             → { ok, sessions: [...], housekeeping }（行含 workspaceId / workspace / headered；housekeeping 报告本次自动收尾的 cleaned / removed / remaining / problems，removed 是实际清掉残留的条数）
POST /api/session-purge/delete           → { sessionId } → { ok, deleted[], freedBytes, projRows, wsRefs, tempSweep[], tempSweepTotal, live[], descendants[], cascadeTruncated, existed }
POST /api/session-purge/delete-workspace → { workspaceId } → { ok, workspaceId, workspaceTitle, deleted[], failures[], freedBytes, projRows, wsRefs, tempSweep[], tempSweepTotal, workspaceRecordDeleted, cascadeTruncated }
POST /api/session-purge/redact           → { sessionId, secrets?, prefixes? } → { ok, files[], totalReplacements, backupsResidual, failures }
```

## 安装（会修改 DSH profile）

克隆或下载本仓库（无 npm 依赖），然后**二选一**：把 `dsh-session-purge` 放入 profile 的 bundles 列表，或在目标 profile 的 `cordis.patch.yml` 中 `insert` 一行 `name: 'dsh-session-purge'`。二者都做会加载两次。

> 0.5.22 起宿主路由注册在 `ctx.connection.fetch`；0.5.23 的延迟残留自动收尾也在宿主半。更新已安装副本后需要重启客户端一次；HMR 只会重载插件行/客户端 bundle，不会替换已经注册的旧 `/_dsh/...` 路由，也不会重建插件实例（自动收尾的进程栅栏依赖新实例）。

## 测试

```powershell
node --test test/purge.test.mjs
```

当前 **48/48**（Node 24.21；脱敏用例在无 zstd 的运行时跳过，但 DSH 0.2.2 基线要求 Node ≥ 24.9）。

## 已知限制（如实）

- **无回收站**；不回收 `attachments` 引用计数；
- TEMP 清扫是内容归因：从未提及会话 id 的输出会留存；
- **删除当前正查看的会话宿主不拦**（无窗口守卫），其后界面表现未经端到端验证；
- 子代理不在面板列出（清理依赖主会话级联）；对话页的子代理家族条目是父日志的派生投影，删除后界面残留到重建（磁盘与记账已净）；无 header 的孤儿子代理会以「仅磁盘日志」行列出，可单独删除，但无法按父级级联；
- 驻留会话删除后：宿主仍持代理对象则保守跳过，客户端提示"宿主仍驻留该会话，彻底消失需重启客户端"；幽灵行留到下次重启，重启后的首次面板加载会自动收尾（前提是该次删除已成功并写入 tombstone）；
- Electron 渲染缓存可能短期保留已渲染内容（推断，未端到端验证）；
- 端到端验证：0.2.0-rc.2 真机验证三个路由与两个入口；0.2.1-rc.3 起为逐触点静态审计（2026-10-26）；0.2.2-rc.1 于 2026-11-09 复核宿主触点并实测 list 路由；0.2.2-rc.2 于 2026-11-12 复核 `sessionQuery`/`connection.fetch` 触点，重启后带认证 cookie 实测 `/api/session-purge/list` 200（9 条）与无效 delete body 400；删除/脱敏与"运行中拒绝"等守卫未在真实数据上重新触发。

变更历史见 [CHANGELOG.md](CHANGELOG.md)（自 0.3.4 起记录）。
