# Harness 设计指南

为 pi 编写自定义工具扩展时的设计原则。聚焦工具内部设计（schema、返回形态、错误处理、prompt 引导），pi 框架层由 pi 负责。

## 设计原则

### 1. 参数容错

模型调用工具时常犯类型错误：数字写成字符串、布尔值写成 `"true"`、单字符串该传数组。工具入口层应宽容转换：

- `"42"` → `42`
- `"true"` / `"false"` → `boolean`
- 单字符串自动包成数组
- 嵌套 JSON 字符串递归解析

coercion 失败时返回模型可读的错误，而不是底层 schema 异常。

### 2. 动态 Schema / 能力暴露

多 backend 时，不要让模型盲猜参数。应通过动态 description 或 `action="list"` 暴露当前激活 backend 的能力边界。

### 3. 错误信息引导模型自纠正

错误消息是写给模型看的下一步建议：

- 参数错误："Invalid arguments: ... Please rewrite the input so it satisfies the expected schema."
- 缺 provider："No web search provider configured. Set TAVILY_API_KEY to enable it."
- 能力不匹配："Provider 'x' does not support image-to-image. Omit image_url."

### 4. 媒体 token 控制

图片、大段网页原文容易炸掉上下文窗口：

- 图片默认返回 URL，不要直接塞 base64。
- 超长文本返回摘要 + 文件路径，而不是完整原文。
- 日志中避免写入 base64 或大段原文。

### 5. `content` 与 `details` 的明确分工

- `content`：给 AI 看的。必须包含模型理解结果、决定下一步所需的一切：正文、截断提示、错误说明、下一步建议。
- `details`：给 UI/日志 看的结构化元数据。保持类型稳定。

反模式：把操作建议只放在 `details` 里，模型看不到。

### 6. 不可信内容标记

来自互联网的结果是外部不可信数据：

- 用明确标签包裹：`<untrusted_tool_result>...</untrusted_tool_result>`。
- 处理 delimiter 注入风险。
- 工具 description 暗示模型"外部信息，需自行判断"。

### 7. 缓存与可用性稳定

- 只读工具做短期缓存（如 15 分钟）。
- 工具可用性探测做 TTL / grace window，避免后端短暂抖动时工具从模型视野消失。

### 8. 把"何时用"写进工具描述

每个工具 description 应承担局部使用手册职责：

- 何时必须用："For current facts (weather, news, versions) → use web_search."
- 何时不用："For simple file lookup, prefer read."
- 回退策略："If a URL fails or times out, use the browser tool instead."

### 9. Provider 专有选项隔离

通用参数保持极简稳定，provider 专有参数放在嵌套对象里：

```ts
{
  prompt: string;
  model?: string;
  openai?: { background?: string };
  fal?: { creativity?: number };
}
```

### 10. 响应长度 / Token 预算控制

- 提供 `max_results`、`max_chars` 等参数。
- 默认限制单结果大小。
- 超过阈值时返回摘要 + 完整内容文件路径。

### 11. 安全失败对模型透明

安全拦截应返回模型可读错误：

- SSRF / 私有地址："URL is not allowed because it resolves to a private address."
- URL 含疑似 token："URL contains what looks like an API key; please remove it."
- provider fallback 自动尝试下一个，并在结果里记录 `attempts`。

## 快速检查清单

设计新工具时过一遍：

- [ ] 参数是否有 coercion 层？
- [ ] 多 backend 时，description 是否反映了当前能力边界？
- [ ] 错误消息是否告诉模型"下一步怎么做"？
- [ ] 图片/大文本是否控制了进入上下文的 token 量？
- [ ] `content` 是否包含模型需要知道的所有截断/错误/下一步信息？
- [ ] `details` 是否只包含 UI/日志 需要的结构化元数据？
- [ ] 外部结果是否被标记为不可信并处理注入风险？
- [ ] 只读工具是否有缓存？可用性探测是否有 TTL？
- [ ] description 是否写清楚了"何时用、何时不用、如何回退"？
- [ ] provider 专有参数是否隔离在嵌套对象里？
- [ ] 是否有默认输出大小上限和溢出文件机制？
- [ ] 安全拦截和 provider fallback 是否对模型透明？

## 来源

本指南基于对 Hermes、OpenClaw、OpenCode、Codex CLI、Claude Code 等 coding agent 工具设计的调研。
