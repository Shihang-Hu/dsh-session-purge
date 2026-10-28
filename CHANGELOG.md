# 变更记录

> 本记录自 0.3.4 起维护；更早版本的变更未录入。

## 0.5.9 — 工作区删除改为事务式，修复 workspace.json 悬空 ID

2026-10-29：删除工作区后立刻关闭 Harness，`workspace.json` 可能留下
`global.workspaceIds` 指向已删除记录的状态；下次启动时工作区注册表校验
（`registry order references missing workspace`）失败，侧边栏里所有工作区
都不再显示，且没有 pendingMutation 可供恢复。

### 修复

- **优先调用 `workspaceRegistry.delete()`**：记录与 order 列表的两次写盘由
  harness 自己的 pendingMutation 协议完成；进程在任意一步退出，都会由下次启动的
  `recoverPendingMutation()` 收尾。插件不再在服务可用时直接分两步写域。
- **无 workspace 服务的降级路径也写 pendingMutation 标记**：先用一次
  `global.set` 同时过滤 order 并落 `{ operation: 'delete', workspaceId }`，
  再删记录、清标记，与 `deleteKnown` 的恢复语义一致；任一步崩溃都可恢复。
- **注册表删除失败时不叠加直写**：直接返回问题让用户重试，避免与 registry 的
  回滚/恢复流程竞争。

### 归因补充（定稿时对照 harness 源码）

直写域不仅存在"两次写盘之间退出"的窗口，还会绕开 registry 的内存快照：
`WorkspaceRegistry` 只在自身写路径更新 `state`/`entities`，并不监听
`domain/changed`。因此即使不立刻关闭，之后任一次 registry 操作（新建/重排/
置顶/归档）都可能把旧 order 写回磁盘。`registry.delete()` 同时消除这两条路径；
原记录里的"立刻关闭"是观察到的触发方式，不是唯一方式。

### 同轮加固

- **归档/置顶集合改走 registry**：会话删除清理这两份全局集合时，优先调用
  `unarchiveSession()` / `unpinSession()`（两者都是纯移除、不检查会话存在性），
  避免 registry 内存态在之后一次置顶/归档写回已清理的 id；registry 不认识或
  不存在的条目仍由随后的直写兜底，无该服务时行为与之前一致。
- **降级路径记录写失败即回滚**：`table.delete` 抛错时把 order + pending 标记
  恢复为写前状态（与 `deleteKnown` 一致），不再留下"本次报错、下次启动静默完成
  删除"的中间态；仅当回滚本身失败时保留标记，交由启动恢复。
- **损坏的注册表显式上报**：`workspace.json` 存在但无法解析时，工作区删除与
  会话记账校验都报"工作区注册表无法解析"，不再把它当作"没有注册表"而静默通过。
- **记录删除失败时不再改写文件**：域层仍持有该记录时跳过文件层，避免把分叉从
  域搬到文件。

### 清理（无行为变化）

- **`deleteWorkspaceRecord` 拆分**：主流程只负责顺序，具体动作落在
  `deleteWorkspaceInDomain` / `verifyWorkspaceDomain` / `scrubWorkspaceFile`
  三个小函数；`verifyWorkspaceDomain` 额外返回 `present`，供"域未删净就不动文件"
  判断。
- **`readWorkspaceRegistry` 统一返回 `{ state, error }`**：ENOENT 视为合法缺席，
  其余读取/解析失败带出 `error`，由调用方决定上报还是忽略。
- 测试新增 4 条：registry 删除失败不回落、归档/置顶走 registry、降级路径回滚、
  损坏注册表显式上报。

宿主回归 **33/33**；`package.json` 升版 0.5.9。

## 0.5.8 — DSH 0.2.1-rc.2 兼容性核查；陈旧 manifest 引用清理

针对 2026-10-17 的新版 DSH（`@deepseek-ai/dsh-desktop@0.2.1-rc.2`，asar 18309 项）把插件的
每个宿主/客户端触点与新实现源码逐一对照。结论：**全部服务面与磁盘布局未变，插件保持兼容**；
仅两处小修：

### 清理

- **`dsh.client.inject` 移除 `@deepseek-ai/dsh-client-runtime`**：新版 node_modules 已无此包
  （全实现零引用）。client-modules 对引导图里不存在的注入包是静默跳过
  （`dependency !== void 0` 才递归），所以这条陈旧引用从未生效也无害——但它指向不存在的
  模块，留着只会误导。client 半实际只 require 平台种子表的 `react` / `react-dom`。
- **TEMP 前缀补 `dsh-shell-`**：dsh-subprocess-local 新增的 POSIX-only shell-activity 目录
  （win32 不创建，列出仅为完备）；`dsh-subprocess-launch-*` 落在既有 `dsh-subprocess-`
  前缀内，无需单列。
- **撤回一个静态误判（运行时验证发现）**：静态核查时曾判 "`dsh-acl-skill-*` 在新版已消失、
  保留属遗留"——实测推翻：%TEMP% 中现存 27 个 `dsh-acl-skill-*` 目录，其中一个创建于本次
  更新启动时刻（14:59:35），该前缀在当前构建**仍然活跃**。创建点在已提取的 40+ 实现包中
  均不可见（名字疑为动态拼接，旁证是同族的 `dsh-acl-locks` 目录）。前缀本就保留，清扫覆盖
  无缺口，修正的只是文档表述。
  **2026-10-24 勘误（0.2.1-rc.3 定案）**：创建点已找到——`@deepseek-ai/dsh-sandbox-windows-acl`
  的打包产物（`lib/types-*.js`）逐字调用 `mkdtempSync(join(tmpdir(), "dsh-acl-skill-"))`，
  每次 skill-bundle 沙箱供给创建一个。"已提取源码中不可见/动态拼接"的推测作废（0.5.8 时
  仅提取了部分包，rc.3 全量提取 6946 文件后定案）；前缀清单与清扫行为不变，本条只修正表述。

### 核查确认未变的关键面（与新实现逐条对照）

`AgentStatus` 仍为 `'idle' | 'running'`（typert.host.js: `export type AgentStatus = …`）；
`ctx.sessions.flush(session)` 持久性检查点、`.store`、`.get`、`.list` 不变；
`storage-domain` 的 `global.get/set`、`domain.table('sessions')` 不变；**workspace 域升到
version 2 并新增 `pendingMutation` 标记**——插件对 `workspace.json` 的读-改-写保留全部未知
字段，且清理后的终态满足新启动校验与 `recoverPendingMutation` 的不变量，无需改动；
`webServer.register({ kind: 'exact', … })` 不变；会话磁盘布局仍为
`<root>/<projectKey>/<encodedId>/`，日志仍为逐帧 zstd（`.jsonl.zstd`，插件按
`.endsWith('.zstd')` 匹配仍然命中）；`SessionHeader.parentSession` 不变（v4 头新增
`delegationDepth`/`agentPreset`，不影响级联遍历）；客户端槽位 `settings.section`、
`sidebar.workspaces.session.menu.item`、`shell.overlay` 均在；`api-session/removed` 不变；
主题 token `--dsw-alias-border-l1..l4` 不变；重置命令的 localStorage 前缀全部仍有效
（`dsh.workspace.view` 仍是 v5；`dsh.trajectory.*` 变成子键，按前缀清除恰好覆盖）。

### 运行时验证（0.5.8 代码 × 更新后真实数据）

- 宿主进程 14:59:33 启动晚于 0.5.8 同步（13:55），运行中的宿主已加载 0.5.8；
- **磁盘布局**：现存 6 个会话目录全部位于 `<root>/<projectKey>/session-<uuid>/`，与插件的
  定位约定一致；
- **zstd 帧布局**：最新真实日志 `session.v4.jsonl.zstd`（3.4 MB）解析出 2168 帧、全部可解
  ——脱敏路由的核心假设在 v4 格式日志上成立；
- **workspace.json v2 形态**：`{unit, global, tables}`，global 五键齐全
  （`initialized`/`defaultWorkspaceId`/`workspaceIds`(2)/`archivedSessionIds`/
  `pinnedSessionIds`）、无 `pendingMutation`——插件的整对象读-改-写天然兼容；
- **%TEMP% 实测**：前缀匹配命中现存全部 dsh-* 目录（合计 61 个文件在册），其中没有任何
  文件提及现存 6 个会话的 id——确属无可清残留（演练零删除）；
- **未做 HTTP 实测**：61959 端口的鉴权层属于 harness web GUI（token 只在启动打印的 URL
  里，asar 内无该文案，不向对话暴露凭据）；桌面端插件路由本就经由 `dsh-app://` 内部 fetch
  转发，不走该端口。client 半的加载依据静态证据（引导图对缺失注入包静默跳过 +
  `window.__ModuleLoader__` facade 仍在），打开设置面板目视确认即可。

### 本轮**未做**的项（记录备查）

- 新官方悬停按钮槽位 `sidebar.workspaces.session.row.action`（workspace 行内按钮条）：
  可作为"删除"的第二入口，属新功能——**2026-10-18 用户决定：不做**。
- `ctx.sessionPersistence.stat(id)`（header + sizeBytes 免读日志）理论上可替代 `/list`
  的目录体积测量：口径不同（stat 只算当前日志代，目录加总才是真实磁盘占用），
  小体量下无性能收益——**2026-10-18 用户决定：不做**。

宿主回归 **28/28**；`package.json` 升版 0.5.8。

## 0.5.7 — 性能：会话图与目录体积测量不再重复

### 变更

- **工作区删除只读一次会话图**（`cascadeOrder(ctx, rootId, map)` /
  `purgeTreeInto(..., graph)`）：此前每个成员树都会重新 `childMap`（即重新
  列出全部会话头），N 个成员 = N 次全量列举；现在 `purgeWorkspace` 开头取一份
  快照并全程复用（`purgeTree` 同样只取一次）。已加永久断言：
  `sessionPersistence.list()` 在一次工作区删除中恰好调用 **1** 次。
  复用快照是安全的：删除日志不会改变父子关系，且被先前成员级联覆盖的成员由
  `visited` 集合跳过。
- **`/list` 的目录体积测量改为一池并发**：原先逐行 `await` 自己那棵树的测量，
  行与行串行；现在把全部目录任务摊平进同一个 8 并发池再按行汇总，并发上限不变
  而墙钟时间不再随行数线性叠加（对会话多的 profile 影响明显）。
- 宿主回归 **28/28**（新增 1 条图读取次数断言）；`package.json` 升版 0.5.7。

### 本轮**未做**的项（判断为不值得动，避免无谓改动）

- `report.live[]` 与 list 行的 `parentSession`：客户端确实不读，但它们是**有意
  保留的响应数据**——诊断信息与父子归属，成本只有几十字节；为省这点体积削减
  已文档化的接口面不划算。
- `stripStorageFiles` 里为计数而做的 `stat`：改成 1 次 `readdir` 只省一次调用，
  却让"逐变体检查"变成"先列目录再匹配"，耦合更差，收益不抵复杂度。

## 0.5.6 — 边界线对比度修复；冗余清理（探测缝隙 / 注册表 IO / 复制助手）

### 修复

- **边界线太淡**：从 `dsh-client-ui-theme` 读出真实 token 值——`border-l1`
  亮色是 `#0000000a`（**4% 黑**）、`l2` 10%、`l3` 12%、`l4` 16%（暗色
  `#ffffff0f/1f/29/33`）。此前容器外框用的是 `l1`，等于画了一条 4% 的线，
  所以"太细、和背景对比不明显"。现在：**卡片外框用 `l3`**、组头分隔线与
  行间分隔线用 `l2`；未分组的容器保持 `l2`（更安静）。线宽维持 1px（宿主
  自己的分隔线用 .5px，问题在对比度而非粗细）。

### 清理（无行为变化）

- **删除 `countFiles` 与 `countFile` 注入缝隙**：生产路径从不调用，唯一消费者
  是一个测试探针；"清扫不二次遍历"现在由代码结构保证（不存在重走路径），
  测试改为断言计数（`files`/`scannedFiles`）。
- **`workspace.json` 读写集中**：新增 `readWorkspaceRegistry` /
  `writeWorkspaceRegistry`，替换 `stripStorageFiles`、`verifyAccountingClean`、
  `workspaceMembers`、`deleteWorkspaceRecord` 里的 3 处 `JSON.parse(readFile)`
  与 2 处"staging + 2 空格 JSON + rename"逐字重复——原子写现在只有一处实现。
- **`copyCommand(which, text)` → `copyResetCommand()`**：单一指令时代的残留
  参数删除，`copied` 退化为布尔。
- **`sleep(30)` → `RM_RETRY_SETTLE_MS`** 命名常量。
- 宿主回归 **28/28**；`package.json` 升版 0.5.6。

## 0.5.5 — 去掉工作区/会话的灰色底纹；指令加分号

### 变更

- **移除灰色底纹与灰色色条**（按反馈"工作区与会话前的灰色阴影有必要吗"）：
  组头的 `specific-input-major` 灰底与容器左侧 3px 灰色强调条**取消**，层级
  改由字体（加粗 + 0.2px 字距的工作区名）、发丝线（组头下分隔线 + 行间分隔线）
  和单一容器边框表达；组间距 10→12px。颜色只留给必须醒目的状态：**待确认删除
  时容器转红框 + 极淡红底**。未分组的弱化样式保留。
- **重置布局指令加行尾分号**（两行各自 `;` 收尾），行结构不变。
- 宿主半无改动，测试 **28/28**；`package.json` 升版 0.5.5。

## 0.5.4 — 工作区与会话并为单一容器卡片；指令两行化、叙述精简

### 变更

- **整体衔接（正面回应"问题不在间距，而在与会话的整体衔接"）**：工作区与其
  会话不再靠"缩进 + 间距"暗示从属关系，改为**同一张容器卡片**——标题栏与
  会话列表项共享边框、背景与左侧强调条，列表项之间只用发丝分隔线，悬停整行
  高亮。未分组的弱化样式与"确认删除整卡转红"保留。
- **重置布局的叙述与指令**：
  - 面板说明由三句精简为一句（F12 粘贴两行回车；只清布局、不动快捷键与
    草稿；重载后空白则手动重启）；
  - 指令改为**回车分隔的两行**：第一行清除布局记录，第二行 `location.reload()`
    重载界面；复制文本自带换行，控制台粘贴后回车即执行。
- 删除因容器化而不再使用的 `rowBox` 样式常量。宿主半无改动，测试 **28/28**；
  `package.json` 升版 0.5.4。

## 0.5.3 — 指令收敛回"只清布局 + 重载"；UI 再打磨

### 变更

- **重置布局指令收敛**：0.5.2 的 `localStorage.clear()` 实测反馈"清除内容
  过多"，收敛为**白名单前缀版**——`['dsh.sidebar-right.v1','dsh.sidebar-browser.v1',
  'dsh.workspace.view.v5','dsh.conversation.contentWidth','dsh.trajectory']`
  前缀匹配（`dsh.trajectory` 一并覆盖耗时/折行两项，前缀匹配天然覆盖按会话
  的 `*.v1.<会话id>` 键），仍以 `location.reload()` 收尾。惰性启动标记键不再
  占面板篇幅（README 备有含标记的精确边界变体）。`localStorage.clear()` 降级
  为 README 里的"更宽"备选。
- **UI 再打磨**：
  - **未分组**组头弱化：无底色条带、强调条降灰、名称用次级文字色——视觉上
    与命名工作区拉开层次；
  - 「删除工作区」待确认时**整条组头转红**（背景淡红 + 强调条红），危险
    状态更醒目；
  - 会话行悬停加 120ms 过渡；组与组之间增加 10px 间距。
- 宿主半无改动，测试 **28/28** 不变；`package.json` 升版 0.5.3。

## 0.5.2 — 指令简化为单条（清除 + 重载一体）；UI 细化

### 变更

- **重置布局指令简化为单条**（按反馈：不是加条目，而是简化原条目并自带
  界面重启）：`localStorage.clear();location.reload()`——粘贴一次即完成
  "清全部本地记录 + 重载界面"。范围警告保留在指令下方；`dsh-app://` 协议下
  重载有"空白文档"的既往实测记录，故注明兜底：空白就手动重启客户端。
  精确白名单指令从面板移除、README 备查。0.5.1 的"内置命令未找到"结论不变。
- **UI 细化**：
  - 工具栏："全部会话 / 仅磁盘残留" 合并为**分段控件**（活动侧着色）；
  - 会话行：去掉与组头重复的工作区徽标；id 行改等宽小字并降低透明度；
  - 组头说明行只留体积，删除警告文案移入按钮悬停提示（减少常驻噪音）。
- 宿主半无改动，测试 **28/28** 不变；`package.json` 升版 0.5.2。

## 0.5.1 — 分组默认收起、视觉分层与指令块重构

### 变更

- **分组默认收起**：状态集合从"已收起"反转为"已展开"——空集合即全部收起，
  逐组点开；搜索时仍强制全部展开。
- **视觉分层**：工作区组头改为**着色条带**（扁平背景 + 左侧 3px 强调条 +
  加粗名称 + 会话数徽标 + 体积说明），不再是与普通行同款的盒子；**会话行
  统一缩进 20px** 并加悬停高亮，层级一眼可辨；「删除工作区」待确认时组头
  强调条变红提示危险状态。全部仍走宿主主题 token，跟随深浅色。
- **指令块重构**：改为两条指令、各自独立复制按钮与范围说明——
  1. **简单**：`localStorage.clear()`（一条命令，布局必定重置；会连带清掉
     快捷键、问答草稿等非布局记录，明示警告；会话数据在宿主目录不受影响）；
  2. **精确**：0.5.0 的白名单指令原样保留为备选。
  关于"控制台内置命令"：对发行前端主包（0.2.0-rc.2）做了全文检索，**未找到**
  resetLayout/clearLayout 之类的内置命令；若你指的是别的命令，告诉我名称即
  可替换。`package.json` 升版 0.5.1。宿主半无改动，测试 **28/28** 不变。

## 0.5.0 — 工作区分组可折叠；布局重置卡片改为控制台指令

### 新增

- **工作区分组展开/收起**：组头新增「展开/收起」按钮，工作区名也可点击切换
  （收起时名字前显示 ▸）。收起状态只存在于当前面板会话内，不持久化；**搜索
  时自动全部展开**，避免匹配行被藏在收起的组里看起来像"搜不到"。收起的组
  头与成员行间距随之调整。

### 变更

- **移除「界面布局」设置卡片，改为控制台指令文本**（0.3.0 引入的卡片于本版
  移除）：布局重置低频且本质是控制台操作，「会话清理」面板底部现在提供指令
  文本（等宽、整段可选中）与「复制」按钮——按 F12 粘贴执行后重启客户端。
  指令白名单与旧卡片完全一致，并**顺带清理 ≤0.4.x 遗留的启动标记键**
  `dsh.session-purge.reset-layout-on-boot`（卡片移除后该键已无作用，惰性残留，
  0.3.x/0.4.x 时代置入的标记不会再被执行、也不会有害）。随卡片一并移除：
  `LAYOUT_KEYS` / `scanLayoutKeys` / `clearLayoutKeys` / 启动标记机制 /
  `LayoutPanel` 及其设置槽位注册。`package.json` 升版 0.5.0，描述同步更新。
- 宿主半本轮无改动，测试 **28/28** 不变；客户端半无自动化测试（历来如此），
  以 `node --check`、引用扫描与指令字符串可执行性验证。

## 0.4.1 — 修复：删除工作区遗留 order 列表悬空 id（0.4.0 事故）

### 修复

- **`deleteWorkspaceRecord` 补清 `global.workspaceIds`（0.4.0 引入的启动级缺陷）**
  0.4.0 的「删除工作区」只清了域表记录与 `workspace.json` 的 `tables.workspaces`
  条目，没有把 id 从 `global.workspaceIds` 顺序列表里摘掉。宿主
  `workspaceRegistry` 在启动时校验"顺序列表中的每个 id 必须存在表记录"（抛
  `workspace domain is inconsistent: registry order references missing
  workspace '…'`），于是删除过工作区后 DSH 无法启动、workspaceController
  不可用（2026-10-15 08:37 触发；数据侧当天已单独修复，插件侧即本条）。
  现在与宿主自身 `deleteKnown()` 的语义完全对齐：
  - 域表记录删除之外，通过 `ws.global.set` 把 id 从域 `global.workspaceIds`
    过滤（域内存是权威，后续落盘自然一致）；
  - 文件层在同一笔原子读改写里同时清除记录与顺序列表条目；
  - 事后验证扩到两层四项（域表 / 域顺序列表 / 文件记录 / 文件顺序列表）；
  - `defaultWorkspaceId` 与宿主一致**刻意保留**，不做清理。
- 新增断言：删除后两层顺序列表均不含该 id，且宿主启动不变量（顺序列表 ↔
  表记录一一对应）在文件与域两层都成立；部分失败保留工作区时顺序列表原样
  不动。测试仍 **28/28**。

## 0.4.0 — 按工作区分组与工作区删除

### 新增

- **设置面板按工作区分组**：会话列表按所属工作区分组展示——组头显示工作区名、
  会话数与合计体积（中文名排序，未分组殿后）；搜索与"仅磁盘残留"筛选在组内
  生效，无匹配行的组不显示。`listSessions` 行新增 `workspaceId` 供分组。
- **删除整个工作区**（组头「删除工作区」，两段确认：确认按钮显示成员会话数，
  Enter 确认 / Esc 取消 / 10 秒自动撤防）：
  - 新路由 `POST /_dsh/session-purge/delete-workspace`（`{ workspaceId }`），
    客户端超时 600s（多棵会话树 + 共享清扫，耗时合法地长于单会话删除）；
  - **顺序**：先逐棵清除成员会话（含子代理级联；跨树去重——已被先前成员级联
    覆盖的成员跳过，报告不重复计数），整棵树集合**共享一次 TEMP 归因清扫**，
    全部成功后才删除工作区记录（域表 `delete` + `workspace.json` 双层，事后
    验证两层都已删净）；
  - **护栏**：任一成员会话运行中 → 409 整体拒绝（未动任何数据）；部分成员
    失败 → **保留工作区记录**以便重试，报告 `failures[]` 逐条列出原因，面板
    摘要显示失败 id（注：按会话既有流程，失败成员的工作区归属可能已被清出，
    故失败 id 支持单独重试删除）；
  - 成员解析以域表为准、`workspace.json` 兜底；空工作区仅删记录。
- 测试 +6（成员全清与记录双层删除、运行中整体拒绝、部分失败保留工作区、
  空工作区文件回退、非法 id、listSessions 的 workspaceId），**28/28 通过**；
  `package.json` 升版 0.4.0。

## 0.3.4 — 宿主半修复、冗余清理与客户端完善

### 修复

- **脱敏：备份清理失败不再回滚**（`lib/index.js` `redactLogFile`）
  原实现把"删除备份"放在写回事务的 `try` 内，与"写回 + 校验"共用同一个 `catch`；
  当备份因被占用而删不掉时，`catch` 会把**备份覆盖回日志文件**——即把刚刚脱敏并
  校验通过的文件还原成含敏感值的原文，同时向调用方抛错。客户端 `entry.changed`
  保持 `false`，于是报告"0 个文件被改写"，而实际发生的是"脱敏成功又被撤销"。
  现在只有**写回失败**才回滚；备份清理失败改为在结果条目上报告
  `backupResidual`（路径）与 `backupError`（原因），`redactSession` 汇总为
  `backupsResidual` 计数。已新增两条针对性用例：清理失败保留脱敏结果、写回失败
  仍然正确回滚。

### 变更

- **TEMP 内容归因清扫改为整棵级联一次**（`sweepTempOutputs` / `sweepTreeTempOutputs`）
  原先每个会话各扫一遍：一个带 N 个子代理的删除要 `readdir` 整个 TEMP、`lstat`
  全部候选目录、并完整读入每个候选文件 **N 次**。现在 `purgeTree` 在全部日志清完
  后只扫一次，并把每个被删目录归因给所有提到其 id 的会话（一个 run 可能同时提到
  父会话与子代理）；报告的 `tempSweep` 仍然按会话分条，形状不变。
  返回结构由 `{ dirs, files, scannedFiles, budgetHit }` 改为
  `{ scannedFiles, budgetHit, sessions: Map<id, { dirs, files, scannedFiles, budgetHit }> }`。
- **级联深度截断显式化**（`cascadeOrder` / `purgeTree` / 客户端）
  `cascadeOrder` 改为返回 `{ order, truncated }`；`truncated` 是**精确判定**
  （只有确实存在因深度上限未遍历的子代理边才置位——frontier 非空但无子结点
  不算）。超过 `MAX_CASCADE_DEPTH`（8 层）的子代理依旧不删，但 delete 响应带
  `cascadeTruncated: true`，完成对话框与面板摘要都会提示，不再静默丢弃。
- **客户端请求有界等待**（`postJson` + 三个调用点）
  删除 180s / 脱敏 600s 超时（`AbortController`）。此前宿主一挂起，对话框会
  锁死到浏览器级 fetch 超时（可达数分钟）；现在超时后对话框解锁，并说明
  **操作可能仍在宿主后台执行**（放弃的只是等待，不是操作本身）。
- **界面文案修复**：布局卡片两处把 markdown 加粗标记（`**…**`）写进了纯文本
  字符串，React 会原样显示星号，改为纯文本。
- **脱敏逐文件隔离**（`redactSession` / 客户端完成视图）
  多个日志文件相互独立：单文件失败不再中断其余文件、也不再丢弃整份报告（原先
  一个坏文件会让整个请求 500，看不到哪些文件已经改好）。失败计入 `failures`，
  该文件条目带 `error`；完成对话框汇总提示"N 个文件处理失败（其余文件不受
  影响）"并逐文件显示原因。空文件/损坏文件（检测不到 zstd 帧）条目带 `note`
  （"未检测到 zstd 帧"），不再伪装成"无需改动"。
- **TEMP 清扫摘要去重**（`tempSweepTotal` / 客户端摘要）
  delete 响应新增 `tempSweepTotal`（全局唯一目录数/文件数）。按会话归因的
  `tempSweep[]` 会把共享目录在每个提及它的会话下各计一次，求和可能夸大；
  客户端摘要优先使用去重合计，无该字段的旧报告回退为求和。
- **脱敏对话框补掩码泄露提醒**：掩码保留前 4 位与长度是既有设计（便于核对），
  但 6–8 位短值会因此泄露大半——对话框与 README 明示，短值建议改用 prefixes
  或直接轮换。掩码格式本身保持不变。
- **包清单**：`package.json` 升版 0.3.4；`files` 白名单补 `CHANGELOG.md`。

### 清理

- **清扫不再二次遍历**：文件计数改由匹配遍历本身产出（命中即整目录删除的语义不
  变），`lstat` 调用改由 `readdir` 的 dirent 类型替代，每个候选目录的遍历次数由
  两次降为一次。
- **列会话不再逐行重算**：`listSessions` 只枚举一次活会话存储（原先每个会话行都
  重新 `store.keys()`），会话目录体积测量改走有界并发池（`WALK_CONCURRENCY`）。
- **`stripStorageDomains` 拆为 `stripProjectionRows` / `stripWorkspaceRefs`**：
  删除管线对两半的调用时机本来就不同（投影行删两遍、工作区引用只在日志确认
  删除后动），拆开后语义即代码；顺带去掉只写不读的 `available` 字段。
- **`purgeOne` 的 `freedBytes` 测量**与 `listSessions` 一致走并发池。
- **`zstdFrameStarts` 移除不可达分支**（`at <= off && off !== 0` 恒假），并把
  "Node zstd 在首帧结束即停"这一非文档化前提（已在 Node 24 实证）写成注释。
- **`bytesAfter` 改取写入缓冲长度**，省一次 `stat`；`io` 注入面相应收窄为
  readFile/writeFile/rename/rm。
- **更正**：上一轮报告的 B8（"`readJson` 超限分支缺 `return`"）为误读，代码
  本就有 `return`，该项撤回、未做修改。

### 文档

- `README.md` 的已知限制章节补记了 `backupResidual` 与单次清扫语义；
  接口清单补上 `backupsResidual` 字段。
- **删除两处与代码不符的旧描述**（0.2.13 之前语义的残留）：
  - "脱敏拒绝被窗口打开 / 当前的会话"——代码只拒运行中（`agentActive`）；
    驻留会话不持有文件句柄，重写期间没有追加路径，现在如实写明，并在
    "当前会话的 UI 识别不可用"一条里说明宿主**没有**窗口打开守卫兜底；
  - "`ctx.get('spill')` 溢出服务"——代码从未调用，`dsh-spill-*` 与其他工具输出
    目录一样按内容归因清扫，故从删除语义表与 `lib/index.js` 文件头移除；
- 顺带把删除语义表里的 `flush + detach` 改为 `flush`（代码只做 flush，
  驻留对象的驱逐是另一条独立路径 `evictResident`）。
- `lib/client.js` 文件头同样改掉了"宿主因窗口持有而拒绝"的旧说明
  （纯注释，不改客户端行为）。
