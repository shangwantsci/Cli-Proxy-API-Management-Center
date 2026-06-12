# 账号池前端维护地图

这份文档用于避免后续二开时改错页面。生产管理面板已经改成中性品牌的账号池控制台，大多数账号池功能都集中在 `DashboardPage`，不是原版 CPA 的 `AuthFilesPage`。

## 生产入口

- 生产 URL：`https://admin.openstaryu.com/management.html`
- 前端路由入口：`src/router/MainRoutes.tsx`
- 当前主页面：
  - `/` -> `src/pages/DashboardPage.tsx`
  - `/dashboard` -> `src/pages/DashboardPage.tsx`
- 旧入口已经被重定向：
  - `/auth-files/*` -> `/`
  - `/ai-providers/*` -> `/`
  - `/quota` -> `/`

结论：只要截图里是“账号池”“导入账号”“代理池”“策略设置”这套账号池控制台，账号池交互优先检查 `src/pages/DashboardPage.tsx` 和 `src/pages/DashboardPage.module.scss`。

## 文件职责

### `src/pages/DashboardPage.tsx`

这是生产首页账号池的真实实现文件，负责：

- 账号池列表/卡片视图
- 账号搜索、状态筛选、代理筛选、认证方式筛选
- 批量选择、批量策略、批量启用/停用
- 批量删除选中账号
- 一键清除全部或选中账号的本地会话占用
- 单账号详情抽屉
- 单账号额度刷新
- 单账号设置、重认证、启用/停用、删除
- 一键检测账号可用性
- Cookie/sessionKey 导入和批量抓取导入
- CLI 伪装状态摘要

关键状态和函数：

- `accounts`：当前页面展示的账号快照。
- `loadAccounts()`：全量加载账号池。只应该用于页面首次进入、手动刷新、批量任务完成、导入任务完成。
- `refreshSingleAccountSnapshot(name)`：轻量刷新某一个账号快照，不触发整池 loading。
- `quotaByAccount`：按账号名保存“订阅与额度”的前端查询结果。
- `handleRefreshAccountQuota(account)`：单账号额度刷新。生产要求是局部更新，不允许再调用 `loadAccounts()`。
- `detailAccountName` / `detailAccount`：列表行点击后打开右侧详情抽屉。
- `openEditor(account)`：打开账号设置弹窗。
- `selectAllAccounts()`：切换“当前筛选结果”的全选状态；表头 checkbox 和工具条按钮共用它。
- `handleBatchDeleteAccounts()`：批量删除当前选中账号，必须保留二次确认。
- `renderPortal(...)`：把弹窗/抽屉挂到 `document.body`。Portal 指 React 把组件渲染到当前组件树之外的 DOM 节点，避免长页面滚动容器影响 fixed 定位。
- `ACCOUNT_VIEW_MODE_STORAGE_KEY`：账号池视图偏好。升级默认视图时要变更这个 key，否则用户浏览器里的旧偏好会继续把页面锁到旧视图。

### `src/pages/DashboardPage.module.scss`

这是生产首页的样式文件，负责：

- 账号池表格：`.accountTableShell`、`.accountTable`、`.accountTableRow`
- 账号卡片：`.accountCard`、`.accountGrid`
- 详情抽屉：`.drawerBackdrop`、`.accountDetailDrawer`
- 设置和批量策略弹窗：`.modalBackdrop`、`.modal`
- 额度面板、健康条、状态标签等账号池细节样式

### `src/services/api/authFiles.ts`

账号池管理 API 封装，常用入口：

- `listClaudeHealth()`：读取带健康状态的账号列表。
- `patchFields(name, fields)`：保存账号代理、优先级、RPM、会话上限、伪装策略等字段。
- `clearRuntimeSessions(...)`：清除全部或指定账号的本地会话占用；只释放运行态会话槽，不删除账号或认证文件。
- `setStatus(name, disabled)`：启用或停用账号。
- `deleteFile(name)`：删除账号文件。
- `reauthenticateClaude(name)`：重新认证账号。
- `startClaudeProbeJob(...)`、`getClaudeProbeJob(...)`、`cancelClaudeProbeJob(...)`：一键检测账号可用性任务。

### `src/services/api/claudeSessionImport.ts`

批量抓取来源中的 sessionKey 并按现有认证逻辑导入账号池。注意导入任务有两段出站：先抓取来源列表，再验证/换授权。`proxy_url` 留空时，后端必须从已启用代理池随机选择代理用于来源抓取和账号验证，避免来源抓取走服务器本机 IP；指定 `proxy_url` 时使用指定代理。

### `src/pages/AuthFilesPage.tsx`

这是原版 CPA 的通用授权文件管理页。当前生产路由 `/auth-files/*` 已经重定向到 `/`，所以不要把账号池的新交互只加到这里。只有明确要恢复或维护旧通用页面时才修改它。

## 后端相关入口

后端仓库是 `F:\claude反代\CLIProxyAPI`。

常见账号池后端能力：

- OAuth / Cookie 换授权 / CLI 风格授权：`internal/auth`、`internal/runtime` 下的 provider 相关文件。
- 账号健康、冷却、RPM、会话状态：`internal/runtime` 和管理路由相关文件。
- 一键检测任务：搜索 `claude-probe-jobs`。
- 代理池：搜索 `proxy pool`、`proxy_url`、`ProxyPool`。
- 生产部署文档：`F:\claude反代\CLIProxyAPI\docs\production-deployment-23.153.36.12.md`。

## 行为变更记录（2026-06-02）

两处与账号池状态相关的后端行为已调整，前端无需改动（状态分类前端已支持）：

- **一键检测对 setup-token 账号发真实请求**：此前 setup-token 账号（生产号池全部是这类）在一键检测时被短路直接判健康、不发任何网络请求（表现为"不到 1 秒检测完所有账号"）。现已改为对每个 setup-token 账号发一次真实 `POST /v1/messages` 探测（走账号同源代理 IP），按响应分类：2xx=健康(`ok`)、`organization_disabled`/`account_banned` 等永久错=`permanent_disabled`、429=`rate_limited`、5xx/超时/网络错=`unavailable`/需处理。实现见 `internal/api/handlers/management/claude_probe_jobs.go` 的 `runClaudeProbeForAuth` setup-token 分支 + `claudeMessagesProbePOST` + `recordClaudeMessagesProbeHTTPFailure`。非 setup-token（OAuth 全 scope）账号仍走原 profile/usage 探测，行为不变。
- **手动重认证清除限额冷却**：此前账号被打上"限额冷却"（被动配额 cooldown）后，手动点重认证无法清除——成功 reauth 只重置了认证失效状态，不碰 `Quota`/被动配额字段。现已在 `ReauthenticateClaudeAuthFile` 成功路径调用 `clearClaudeQuotaCooldownState`，清除账号级与 per-model 的配额冷却及被动配额 metadata，使账号立即恢复可用。注意：仅"用户手动重认证"清冷却；conductor 后台自动 refresh 不清（被动配额冷却是其正常生命周期）。

## 修改账号池 UI 前的检查清单

1. 先确认截图/问题所在路由：
   - 浏览器地址是 `/` 或 `/dashboard`：改 `DashboardPage`。
   - 浏览器地址是 `/config`：改 `ConfigPage` 或配置组件。
   - 浏览器地址是 `/proxies`：改代理池页面。
2. 搜索页面上可见文案，确认命中的文件就是实际渲染文件。
3. 涉及账号池主列表时，优先改 `DashboardPage.tsx`。
4. 涉及账号池样式时，优先改 `DashboardPage.module.scss`。
5. 单账号操作不要默认调用 `loadAccounts()`：
   - 额度刷新、保存设置这类单账号动作，应使用局部状态更新或 `refreshSingleAccountSnapshot(name)`。
   - 批量检测、批量修改、导入任务完成后，才适合全量刷新。
6. 弹窗、抽屉必须用 `renderPortal(...)` 挂到 `document.body`，避免在长页面中打开后出现在页面中部。
7. 表格行点击打开详情时，checkbox、按钮、下拉框必须 `stopPropagation()`，否则会误打开抽屉。

## 验证清单

每次前端账号池改动后至少执行：

```bash
npm run type-check
npm run lint
npm run build
rg -n -i "claude|anthropic" dist
```

`rg` 对 `dist` 的扫描必须无结果。管理面板对外域名可被静态扫描，生产构建后的 `management.html` 不能包含敏感 provider 明文字面量；`npm run build` 会自动执行 `scripts/sanitize-management-html.mjs`。

人工检查项：

- `/` 默认显示账号池主页面。
- 账号池默认是列表视图；切换卡片后刷新页面能保留偏好。
- 点击列表行能打开右侧详情抽屉。
- 点击 checkbox 不打开抽屉。
- 表头 checkbox 能一次性选择或取消当前筛选结果。
- 选中账号后能看到“批量删除”，点击时必须出现二次确认。
- 点击“额度”只刷新该账号额度，不出现整池 loading 或滚动位置跳动。
- 点击“设置”时弹窗出现在当前视口中央，不需要滚动寻找。
- 关闭设置弹窗后，详情抽屉仍能正常关闭或继续操作。
- 一键检测按钮在账号池工具条中可见。

## 部署提醒

前端构建产物最终由后端服务加载，生产文件是服务器上的：

```text
/opt/cpa-claude-proxy/static/management.html
```

本地改完前端后，需要重新构建并上传新的 `dist/index.html`。仅提交 GitHub 不会自动更新服务器页面。
