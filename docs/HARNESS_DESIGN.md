# Harness 设计指南（LLM 友好型工具设计）

> 本文档汇总我们在研究主流 coding agent（Hermes / OpenClaw / OpenCode / Codex CLI / Claude Code）时学到的、对 harness / 工具设计有直接指导意义的模式。  
> 它是**不断迭代**的：每完成一次调研或一次实现，就把新学到的原则或反模式补充进来。  
> 当前版本基于 [#4 调研主流 coding agent 的工具设计取舍](https://github.com/Grapedge/grapi/issues/4)。

## 适用范围

- 为 pi（`@earendil-works/pi-coding-agent`）编写自定义工具扩展。
- pi 用 `pi.registerTool()` 注册工具，typebox 定义参数 schema，`promptSnippet` / `promptGuidelines` 让工具进入 system prompt，工具返回 `{ content, details }`。
- 本指南聚焦**工具内部设计**（schema、返回形态、错误处理、prompt 引导等），pi 框架层的外壳由 pi 负责。

---

## 设计原则

### 1. 参数容错（Parameter coercion）

> 来源：Hermes `coerce_tool_args()`

模型调用工具时经常犯“类型对不上”的小错误：数字写成字符串、布尔值写成 `"true"`、该传数组却只传了一个字符串。不要直接抛 schema 校验错误，而是在工具入口层做宽容转换。

**推荐做法：**

- `"42"` → `42`
- `"true"` / `"false"` → `boolean`
- 单个字符串自动包成数组：`{"urls": "https://a.com"}` → `{"urls": ["https://a.com"]}`
- 嵌套 JSON 字符串递归解析

**Checklist：**

- [ ] 工具入口是否有参数 coercion 层？
- [ ] coercion 失败时是否返回模型可读的错误（而不是底层 schema 异常）？
- [ ] 是否在错误消息里告诉模型“请按 schema 重写”？

---

### 2. 动态 Schema / 能力暴露（Dynamic schema）

> 来源：Hermes `dynamic_schema_overrides`、OpenClaw `action="list"`

如果同一个工具背后可能接多个 backend（如 fal.ai 的多个模型、多个搜索 provider），不要让模型盲猜当前支持哪些参数。应该在运行时把“当前激活 backend 的能力”暴露给模型。

**两种方式：**

1. **动态 description**：在 `get_tool_definitions()` 时根据当前配置改写工具 description，写明当前 backend、支持的枚举值、是否支持 image-to-image 等。
2. **模型自省**：提供 `action="list"` 之类的参数，让模型主动查询当前可用 provider / model / 参数集合。

**Checklist：**

- [ ] 多 backend 时，description 是否反映了当前激活 backend 的能力边界？
- [ ] 模型是否能通过某种方式查询可用 provider/model？
- [ ] 是否避免了“模型传了参数但 backend 不支持”的浪费调用？

---

### 3. 错误信息引导模型自纠正（Actionable errors）

> 来源：Hermes / OpenCode / Codex

错误信息不是给人看的堆栈，而是给模型看的“下一步行动建议”。

**推荐做法：**

- 参数错误：`"Invalid arguments: ... Please rewrite the input so it satisfies the expected schema."`
- 缺 provider：`"No web search provider configured. Run ... to set one up."`
- 能力不匹配：`"Provider 'x' does not support image-to-image. Omit image_url for text-to-image."`

**Checklist：**

- [ ] 错误消息是否包含“下一步怎么做”？
- [ ] 参数错误是否映射为模型可见文本，而不是抛异常中断会话？
- [ ] 后端错误是否经过收敛/翻译，而不是直接把 HTTP status 丢给模型？

---

### 4. 媒体 token 控制（Media token hygiene）

> 来源：Hermes base64 替换、Codex log_preview 占位符、Claude Code Haiku 二次总结

图片、大段网页原文很容易把上下文窗口炸掉。工具层要主动控制进入模型上下文的媒体体积。

**推荐做法：**

- 图片默认返回 CDN URL，不要直接塞 base64 进 `content`。
- 如果必须返回 base64，在日志/预览中用占位符（如 `[generated image]`）替换。
- 网页抓取结果超长时，返回摘要 + 文件路径，而不是完整原文。
- 对非关键域内容可用小模型二次总结后再给主模型。

**Checklist：**

- [ ] 图片/媒体是否默认返回 URL 而不是 base64？
- [ ] 日志中是否避免写入 base64 或大段原文？
- [ ] 超长文本是否溢出到文件并返回路径？
- [ ] 是否有单结果 token 上限（如 50KB / 100KB）？

---

### 5. `content` 与 `details` 的明确分工（Result shaping for AI vs UI）

> 来源：pi 内置 `read` / `bash` / `grep` 工具

pi 的 `AgentToolResult<T>` 已经明确分层：

- `content: (TextContent | ImageContent)[]` —— **给 AI 看的**。必须包含模型理解结果、决定下一步行动所需的一切信息。
- `details: T` —— **给 UI/日志看的**。结构化元数据，用于 `renderResult` 渲染更漂亮的界面，或写入 telemetry。

**关键反模式：** 把“下一步操作建议”只放在 `details` 里。模型看不到 `details`，所以任何需要模型知道的信息都必须出现在 `content` 中。

**推荐做法：**

- `content` 里放：正文结果、截断提示、错误说明、可操作的下一步建议（如 `"Use offset=201 to continue"`、`"Use limit=200 for more"`）。
- `details` 里放：结构化元数据，如 `truncation`、`fullOutputPath`、`provider`、`attempts`、`matchLimitReached`。
- 保持 `details` 类型稳定，便于 UI 组件统一处理。

**示例：**

```ts
// content（给 AI）
"Line 1: ...\nLine 2: ...\n\n[Showing lines 1-200 of 5000. Use offset=201 to continue.]"

// details（给 UI）
{
  truncation: {
    truncated: true,
    outputLines: 200,
    totalLines: 5000,
    fullOutputPath: "/tmp/pi-bash-xxx.txt"
  }
}
```

**Checklist：**

- [ ] 模型需要知道的截断/错误/下一步信息是否都在 `content` 中？
- [ ] `details` 是否只放 UI/日志 需要的结构化元数据？
- [ ] `details` 字段命名是否稳定、可复用？

---

### 6. 不可信内容标记（Untrusted content marking）

> 来源：Hermes `<untrusted_tool_result>`

来自互联网的结果（搜索、网页抓取）是外部不可信数据。应该明确标记，并防止其内容污染 prompt 结构（如注入、delimiter 冲突）。

**推荐做法：**

- 用明确标签包裹外部结果：`<untrusted_tool_result>...</untrusted_tool_result>`。
- 替换或转义结果内部可能与 prompt delimiter 冲突的字符/序列。
- 在工具描述里暗示模型“这是外部信息，需要自行判断”。

**Checklist：**

- [ ] 搜索/抓取结果是否被标记为不可信来源？
- [ ] 是否处理了 delimiter 注入风险？
- [ ] 模型是否能区分“用户输入”和“工具返回的外部数据”？

---

### 7. 缓存与可用性稳定（Caching & availability stability）

> 来源：Hermes `check_fn` TTL + grace window、Claude Code WebFetch 15 分钟缓存

避免重复调用和工具“时隐时现”导致模型困惑。

**推荐做法：**

- 对 `web_fetch` 等幂只读工具做短期缓存（如 15 分钟）。
- 对工具可用性探测结果做 TTL 缓存（如 30 秒），并保留 grace window（如 60 秒），避免后端短暂抖动时工具从模型视野里消失。

**Checklist：**

- [ ] 只读工具是否有合理的缓存策略？
- [ ] 工具可用性探测是否有 TTL / grace window？
- [ ] 缓存是否不会导致模型看到过时的“可用性”或“结果”？

---

### 8. 把“何时用”写进工具描述（Usage guidance in description）

> 来源：Codex `.md` description、Hermes / OpenClaw 工具 description

系统 prompt 容易过长且与具体工具脱节。每个工具的 description 应该承担“局部使用手册”的职责。

**推荐做法：**

- 说明何时用："For current facts (weather, news, versions) → use web_search"。
- 说明何时不用："For simple information retrieval, prefer web_search or web_extract (faster, cheaper)."
- 说明回退策略："If a URL fails or times out, use the browser tool instead."
- 说明输出格式和限制。

**Checklist：**

- [ ] 每个工具 description 是否说明了“何时必须用、何时优先用别的”？
- [ ] 是否写了常见失败场景和回退方式？
- [ ] 是否把 provider 特有的用法提示隔离在通用描述之外？

---

### 9. Provider 专有选项隔离（Provider-specific option isolation）

> 来源：OpenClaw `openai: {...}` / `fal: {...}` 嵌套对象

通用参数保持极简和稳定，provider 专有参数不要污染顶层 schema。

**推荐做法：**

```ts
{
  prompt: string;           // 通用
  model?: string;           // 通用
  size?: string;            // 通用
  openai?: {               // provider 专有
    background?: string;
    moderation?: string;
  };
  fal?: {                  // provider 专有
    creativity?: number;
  };
}
```

**Checklist：**

- [ ] 通用参数是否只包含所有 provider 都支持的概念？
- [ ] provider 专有参数是否放在嵌套对象里？
- [ ] 模型是否能通过 `action="list"` 或动态 description 知道专有参数的合法值？

---

### 10. 响应长度 / Token 预算控制（Response length governance）

> 来源：Codex `response_length`、Hermes `budget_config`、Claude Code 10MB/100K 字符限制

工具返回不应无限制地占用上下文窗口。需要在工具层显式控制输出规模。

**推荐做法：**

- 提供 `max_results`、`max_chars`、`response_length` 等参数。
- 默认限制单结果大小（如 20K 字符、50KB、5MB HTTP body）。
- 超过阈值时返回摘要 + 完整内容文件路径。
- 根据当前模型 context window 动态调整上限。

**Checklist：**

- [ ] 是否有默认的输出大小上限？
- [ ] 超过上限时是否返回文件路径而不是截断但不告知？
- [ ] 是否有参数让模型主动控制返回长度？
- [ ] 是否按模型 context window 缩放上限？

---

### 11. 安全失败对模型透明（Security failures as model-readable errors）

> 来源：Hermes SSRF / token-in-URL 拒绝、OpenClaw provider fallback、Claude Code 域名预检

安全拦截不应该让模型看到一堆堆栈，也不应该默默失败。应该返回模型能理解、能采取行动的错误。

**推荐做法：**

- SSRF / 私有地址拦截：`"URL is not allowed because it resolves to a private address."`
- URL 含疑似 token：`"URL contains what looks like an API key; please remove it."`
- 某个 provider 失败但还有 fallback：自动尝试下一个，并在结果里记录 `attempts`。
- 域名被拦截：`"Domain blocked by policy; if you believe this is an error, ask the user."`

**Checklist：**

- [ ] 安全拦截是否返回模型可读的错误？
- [ ] 是否有 provider fallback 机制，并把尝试记录返回给模型？
- [ ] 是否避免了把内部错误细节泄露给模型？

---

## 待补充 / 待验证区

> 下面这些点我们认为有价值，但还没想清楚是否放入正式指南，或需要更多实战经验：

- **长任务进度与异步化**（progress / background task）：OpenClaw / Hermes 的做法。grapi 第一版工具都是同步的，未来遇到生视频/长队列任务时需要补充。
- **模型自省模式** `action="list"`：动态 schema 之外，是否每个多 backend 工具都应该提供 list/status 动作？
- **`content` 与 `details` 的分工**：pi 已经确定 `content` 给 AI、`details` 给 UI/日志，但 harness 是否需要约定 `details` 内部字段（`truncation` / `provider` / `attempts` / `fullOutputPath` 等）的命名规范？

---

## 快速检查清单（设计新工具时过一遍）

- [ ] 参数是否有 coercion 层，能容忍模型的常见类型错误？
- [ ] 多 backend 时，description 是否反映了当前能力边界？
- [ ] 错误消息是否告诉模型“下一步怎么做”？
- [ ] 图片/大文本是否控制了进入上下文的 token 量？
- [ ] `content` 是否包含模型需要知道的所有截断/错误/下一步信息？
- [ ] `details` 是否只包含 UI/日志 需要的结构化元数据？
- [ ] 外部结果是否被标记为不可信并处理了注入风险？
- [ ] 只读工具是否有缓存？可用性探测是否有 TTL / grace window？
- [ ] description 是否写清楚了“何时用、何时不用、如何回退”？
- [ ] provider 专有参数是否隔离在嵌套对象里？
- [ ] 是否有默认输出大小上限和溢出文件机制？
- [ ] 安全拦截和 provider fallback 是否对模型透明？

---

## 变更日志

| 日期       | 变更                                                                           |
| ---------- | ------------------------------------------------------------------------------ |
| 2026-07-12 | 初版，基于 #4 对 Hermes / OpenClaw / OpenCode / Codex CLI / Claude Code 的调研 |
