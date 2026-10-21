# dsh-audit-plugin

DeepSeek Harness 的**会话成本审计**插件。每个 turn 结束自动审计当前会话，
把 token 花在哪些节点上算清楚，并给出可执行的修改建议。

> 不是画时间轴，是回答「哪一步白花了钱、改什么能省回来」。

## 安装

```bash
dsh plugin --profile web add dsh-audit-plugin
```

装完在 Web UI 的「插件」页可见，默认启用。本地开发用 `file:`：

```bash
dsh plugin --profile web add file:/绝对路径/packages/dsh-audit-plugin
```

## 输出

```
$DSH_HOME/dsh-audit/latest.txt              最近一次完整报告
$DSH_HOME/dsh-audit/report-<sessionId>.txt  按会话归档
$DSH_HOME/dsh-audit/errors.log              仅出错时出现
```

**目前只写文件，没有 UI 面板。** 这是有意的：插件不改动 Web 界面，
装坏了也不会让界面出问题。

## 报告里有什么

- **结论**：最该先改的一条 + 预计可省 token 区间
- **逐步账单**：每步的上下文体量、新增输入、缓存命中率、输出、工具数、失败数
- **工具成本**：按工具聚合的调用次数、失败次数、结果体量
- **平台定价**：`ctx.tokenMeter.measure()` 返回的逐节点 token，带事件标签
- **弃权说明**：证据不足时明确说「这条不报，因为……」

## 口径（重要）

- 账单总额用 `assistant/message.data.usage`（provider 返回，实测）
- 逐节点归因用 `ctx.tokenMeter.measure().nodes[]`（平台按路由定价）
- **`measure().totalTokens` 不是账单**：它含完整请求包络，实测 `totalTokens 10729` 而 `surfaceTokens 2512`
- `baseline.kind` 三种取值：`none`（空会话）/ `estimated`（无用量锚点）/ `usage`（有成功调用作锚）

## 依赖

- `inject: ['sessions', 'sessionQuery', 'tokenMeter']` —— Cordis 下不 inject 就读不到服务
- 不声明 `@deepseek-ai/*` 的 peerDependencies：开发者预览期 API 会变，
  声明了反而容易因版本区间被插件管理器判为不兼容。
  代价是 API 破坏性变更时不会提前告警。

## 许可

MIT
