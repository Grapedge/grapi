# 主流 coding agent 外部能力工具设计对比

> 调研对象：Hermes、OpenClaw、OpenCode、Codex CLI、Claude Code。  
> 聚焦能力：web search、web extract/fetch/browse、image/media generation。  
> 目的：为 grapi 设计同类工具的 **接口契约、返回形态、provider 抽象、LLM 引导策略** 提供参考。  
> 关联工单：[#4 调研主流 coding agent 的工具设计取舍](https://github.com/Grapedge/grapi/issues/4)、[#5 接口与返回形态设计](https://github.com/Grapedge/grapi/issues/5)。  
> 关联素材：[Tavily API 调研](./tavily-api.md)、[fal.ai API 调研](./fal-ai-api.md)。

---

## TL;DR

| 维度              | 主流共识                                                                                                     | 值得注意的差异                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| **工具命名**      | 小写 + 下划线（`web_search`、`image_generate`），Claude Code 用 PascalCase 内部名，下发时映射为 `web_search` | OpenCode 用扁平名 `websearch`/`webfetch`；Codex 用 `namespace.tool`                                           |
| **描述风格**      | bullet + Usage notes，说明“何时用、返回什么、何时不用”                                                       | Codex 把完整使用手册写进 `.md` 文件作为 description；Hermes 用动态 schema 在描述里暴露当前 backend 能力       |
| **参数 schema**   | 少量必填 + 合理默认值；枚举值尽量小；provider 专有选项隔离在嵌套对象                                         | Codex `web.run` 用“命令聚合对象”，一次调用可批量发多个子命令；OpenClaw 用 `action="list"` 让模型自省 provider |
| **返回形态**      | 结构化 JSON 为主，内部字段统一；过大时溢出到文件并给出路径                                                   | Claude Code WebFetch 直接返回小模型总结后的文本；Codex 搜索返回纯文本                                         |
| **错误处理**      | 返回模型可读错误 + 可操作建议；参数错误让模型自纠正                                                          | Hermes 有 `coerce_tool_args` 做字符串/数字/数组容错                                                           |
| **缺配置/key**    | 工具在注册层就被过滤掉（模型看不到），而不是调用时才报错                                                     | OpenCode 无 key 仍按会话稳定选后端，由服务端决定是否放行                                                      |
| **Provider 切换** | 多数由配置决定，模型不选 provider；媒体生成常暴露 `model` 参数让模型覆盖                                     | Hermes 动态 schema 把当前 backend 能力写进描述；OpenClaw `action="list"` 让模型查看可用 provider              |
| **Prompt 指导**   | 系统 prompt 教导“何时必须用工具”；工具 description 承担具体用法                                              | Hermes `/learn` 规范要求用 `web_extract` 而非 curl；Claude Code WebSearch 强制要求 `Sources:`                 |

---

## 1. Web Search 工具对比

| 项目              | Hermes                                                                                                                   | OpenClaw                                                                       | OpenCode                                                                                         | Codex CLI                                                                                      | Claude Code                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **工具名**        | `web_search`                                                                                                             | `web_search`                                                                   | `websearch`                                                                                      | `web.run`（子命令 `search_query`）                                                             | `web_search`（原生服务端工具）                               |
| **必填参数**      | `query`                                                                                                                  | `query`                                                                        | `query`                                                                                          | `q`（在 `search_query[]` 内）                                                                  | `query`                                                      |
| **常用可选**      | `limit` (1–100, default 5)                                                                                               | `count` (1–10, default 5)、`freshness`、`country`、`language`、`domain_filter` | `numResults` (default 8)、`livecrawl`、`type` (`auto/fast/deep`)、`contextMaxCharacters`         | `recency`、`domains`、`response_length` (`short/medium/long`)                                  | `allowed_domains`、`blocked_domains`                         |
| **返回结构**      | JSON：`{success, data: {web: [{title, url, description, position}]}}`                                                    | JSON：顶层 `{provider, ...result}`，含 `results[]`                             | JSON/Text：`{output, title, metadata: {provider}}`                                               | 纯文本 `SearchOutput.output`                                                                   | markdown 形式的 `tool_result`，含链接列表 + `Sources:` 提醒  |
| **Provider 抽象** | 配置 `web.backend` / `web.search_backend`，后端候选：Firecrawl、Parallel、Tavily、Exa、SearXNG、Brave-free、ddgs、xai 等 | 插件 contract `webSearchProviders`，配置/凭证 auto-detect + fallback           | 硬编码 Exa/Parallel，按 `sessionID` checksum 稳定二选一，可用 `OPENCODE_WEBSEARCH_PROVIDER` 覆盖 | OpenAI Responses API 原生 hosted `web_search` 或 Extension `web.run`；由 `model_provider` 决定 | Anthropic 原生 `web_search_20250305`，按 provider/model 门控 |
| **缺配置处理**    | `check_fn` 未通过时工具不暴露                                                                                            | `tools.web.search.enabled === false` 或无法解析 provider 时返回 `null`         | 不校验 key，仍发起请求                                                                           | 非 OpenAI provider 或 `WebSearchMode::Disabled` 时不注册工具                                   | 不支持的 provider/model 直接过滤                             |
| **LLM 提示重点**  | “当前事实、新闻、版本 → 用 web_search”；支持并行调用                                                                     | 描述中写返回 normalized provider results                                       | “必须用当前年份搜索”；结果标题带 `Exa Web Search` / `Parallel Web Search`                        | `web_run_description.md` 里写大量示例、决策边界、引用规范、字数限制                            | 强制要求回答末尾加 `Sources:` 并列出 markdown 链接           |

### 对 grapi 的启示

1. **参数设计保持极简**：只有 `query` 必填，`max_results` / `time_range` / `detail` 作为通用抽象。不要把 Tavily 的 `search_depth`、`chunks_per_source` 直接暴露给模型。
2. **返回统一为结构化 JSON**：至少包含 `results[]`（`title`、`url`、`content`、`score`），可选 `answer`、`usage`、`responseTime`。
3. **Provider 选择对模型透明**：工具 schema 里不需要 `provider` 参数；由 grapi 配置层决定当前激活的 `WebSearchProvider`（如 Tavily）。
4. **缺 key 时隐藏工具**：优于调用时报错，因为模型不会浪费调用机会。
5. **描述里写清使用边界**：例如“用于知识截止日期之后的信息、当前事实、新闻”等。

---

## 2. Web Extract / Fetch / Browse 工具对比

| 项目             | Hermes                                                                                                     | OpenClaw                                                                          | OpenCode                                                             | Codex CLI                                                    | Claude Code                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------- |
| **工具名**       | `web_extract` + 10+ 浏览器工具（`browser_navigate` 等）                                                    | `web_fetch`                                                                       | `webfetch`                                                           | `web.run` 子命令 `open`/`find`/`click`/`screenshot`          | `WebFetch`                                                       |
| **核心语义**     | `web_extract`：无 LLM 摘要的后端抓取 markdown；浏览器工具：交互式浏览                                      | 本地 HTTP + readability 提取，失败可 fallback provider                            | 抓取 URL，返回 text/markdown/html                                    | 搜索/打开/点击/查找/截图聚合在一个工具                       | 抓取 URL → HTML 转 Markdown → Haiku 按 prompt 总结               |
| **必填参数**     | `urls`（最多 5 个）                                                                                        | `url`                                                                             | `url`                                                                | `open[].ref_id` 或 `find[].ref_id` 等                        | `url`、`prompt`                                                  |
| **返回形态**     | JSON：`{results: [{url, title, content, error}]}`；超长 head+tail 截断，完整内容写入文件并提示 `read_file` | JSON：含 `text`、`truncated`、`rawLength`、`fullOutputPath`（溢出到私有临时文件） | `{title, output, metadata}`；图片作为 data URL attachment            | 纯文本                                                       | `{result, bytes, durationMs}`；`result` 是 Haiku 总结            |
| **截断/溢出**    | 默认 15k 字符；head+tail 截断；文件路径提示                                                                | 默认 20k 字符；超出写入临时文件                                                   | 5MB 响应上限；`Truncate` 服务 >50KB 时存文件                         | 由 `truncation_policy.token_budget()` 控制                   | 10MB 上限；Markdown 截断 100k 字符                               |
| **安全/错误**    | SSRF 拦截；URL 含 token 拒绝；失败提示改用 browser 工具                                                    | SSRF 拦截；协议非法拒绝；HTTP 非 2xx 尝试 provider fallback                       | Cloudflare challenge 自动重试一次；非 2xx 收敛为 `Unable to fetch`   | 参数错误 `RespondToModel`；auth 错误 `Fatal`                 | 域名预检；跨主机重定向不自动跟随；企业 egress 拦截               |
| **缺配置处理**   | 同 web_search，`check_fn` 过滤；后端不支持 extract 时报明确错误                                            | `tools.web.fetch.enabled === false` 时返回 `null`                                 | 无需 API key，始终可用                                               | 由 `model_provider` / `WebSearchMode` 门控                   | 无需 API key，始终可用                                           |
| **LLM 提示重点** | “PDF 可直接传；失败改用 browser 工具”；`browser_navigate` 说“简单检索优先用 web_search/web_extract”        | “Lightweight page access; no browser automation”；溢出提示读文件                  | “优先用更 targeted 的工具；URL 必须完整；HTTP 升级 HTTPS；read-only” | `web_run_description.md` 里写 open/find/click 用法、引用格式 | “如果 MCP 提供了 web fetch 优先用 MCP；GitHub 链接优先用 gh CLI” |

### 对 grapi 的启示

1. **能力分层建议**：
   - `web_search`：快速获取多源摘要。
   - `web_extract`：给定 URL 提取正文 markdown（对应 Tavily Extract）。
   - `web_browse`（可选）：需要 JS/交互/表单时才启用浏览器自动化。
2. **返回统一结构**：`{results: [{url, title, content, error}]}` + `failed: [{url, error}]`，部分失败不抛异常。
3. **溢出策略**：超过 token 预算时把完整内容写入文件，返回摘要 + `fullOutputPath`，并提示模型用 `read_file` 读取。
4. **安全**：SSRF 拦截、协议校验、URL 长度/ token 拒绝应在前置层完成。
5. **缺 key 隐藏**：若 provider 未配置，工具不注册；避免模型调用后得到“未配置”错误。

---

## 3. Image / Media Generation 工具对比

| 项目                   | Hermes                                                                                      | OpenClaw                                                                                                                   | OpenCode                                | Codex CLI                                                                            | Claude Code |
| ---------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------ | ----------- |
| **文生图工具名**       | `image_generate`                                                                            | `image_generate`                                                                                                           | 无原生                                  | `image_gen.imagegen`                                                                 | 无原生      |
| **视频/音乐生成**      | `video_generate`、`xai_video_edit/extend`、`text_to_speech`                                 | `video_generate`、`music_generate`                                                                                         | 无原生                                  | 无                                                                                   | 无          |
| **必填参数**           | `prompt`                                                                                    | `prompt`                                                                                                                   | —                                       | `prompt`                                                                             | —           |
| **常用可选**           | `aspect_ratio` (`landscape/square/portrait`)、`image_url`（图生图）、`reference_image_urls` | `model` (`provider/model`)、`size`、`aspectRatio`、`outputFormat`、`background`、`count`、provider 专有对象 `openai`/`fal` | —                                       | `referenced_image_paths` / `num_last_images_to_include`（互斥，最多 5）              | —           |
| **模型/Provider 选择** | 配置 `image_gen.provider`；模型不可选，但动态 schema 暴露当前 backend 能力                  | `model` 参数可覆盖；`action="list"` 让模型查看 provider/model                                                              | —                                       | 硬编码 `gpt-image-2`；由 `model_provider` 决定工具是否暴露                           | —           |
| **返回形态**           | JSON：`{success, image: <url/path>, modality, error}`                                       | 同步：文本 + details（含 `provider/model/attempts/normalization`）；异步：background task handle                           | —                                       | `data:image/png;base64,...` + 保存路径提示；`log_preview()` 固定 `[generated image]` | —           |
| **缺配置处理**         | `check_fn` 检测 `FAL_KEY` 或插件 provider；未通过不暴露                                     | `hasGenerationToolAvailability()` 为 false 时返回 `null`                                                                   | —                                       | 非 OpenAI provider 或不满足 `ProviderCapabilities::image_generation` 时不注册        | —           |
| **LLM 提示重点**       | 动态描述写明当前 backend 是否支持 text-to-image / image-to-image / editing                  | 描述里写 background task、transparent 背景、`action=list` 用法                                                             | kimi.txt 让模型用 shell/python 生成媒体 | `imagegen_description.md` 写编辑 vs 生成选择、引用互斥、生成后不提及下载             | —           |

### 对 grapi 的启示

1. **文生图最小接口**：`prompt` 必填；`model`、`size`/`aspect_ratio`、`n`、`output_format` 可选。
2. **暴露 `model` 参数**：fal.ai 不同模型参数差异大（见 [fal-ai-api.md](./fal-ai-api.md) 第 4 节），建议工具层暴露 `model` 枚举，provider 层透传 endpoint ID。
3. **返回统一结构**：`{images: [{url, width, height, content_type, nsfw?}], seed?, usage?}`。
4. **缺配置隐藏工具**：未设置 `FAL_KEY` 等凭证时，`image_generate` 不注册。
5. **动态 schema 可选**：若未来支持多 backend，可在 description 里追加“当前激活 backend 支持的 aspect_ratio/size 集合”，减少模型误传。

---

## 4. 跨能力设计模式汇总

### 4.1 命名与描述

- **命名**：`web_search`、`web_extract`、`image_generate` 是最常见的函数调用名；Claude Code 内部用 `WebFetch`/`WebSearch`，下发时仍用 `web_search`。
- **描述即 prompt**：Codex 直接把 `.md` 当 description；Hermes/OpenClaw 在 description 里写使用边界、fallback、当前 backend 能力。
- **动态描述**：Hermes 的 `dynamic_schema_overrides` 机制值得借鉴——在 `get_tool_definitions()` 时根据当前配置改写 description，让模型一次调用就能拿到正确参数。

### 4.2 Schema 设计

- **最小必填**：通常只有 `query` / `url` / `prompt` 一个必填字段，其余都带默认值。
- **枚举要小**：`aspect_ratio`、`output_format`、`response_length`、`type` 等用明确枚举，避免模型自由发挥。
- **Provider 专有选项隔离**：OpenClaw 把 `openai: {...}`、`fal: {...}` 嵌套在顶层参数下，既透传专有配置，又不污染通用 schema。
- **批量/聚合**：Codex `web.run` 用顶层可选数组字段让模型一次调用组合多个命令；Hermes `web_extract` 支持最多 5 个 URL。

### 4.3 返回结果塑形

- **统一包装**：Hermes 几乎所有工具返回 `{"success", "data/error"}`；OpenClaw 返回 `AgentToolResult<{content, details}>`。
- **溢出到文件**：Hermes 15k、OpenClaw 20k、OpenCode 50KB 后都把完整内容写入文件并返回路径。
- **base64 控制**：图片默认返回 CDN URL；需要时通过 `sync_mode`/`output_format` 返回 base64，但日志/预览中替换占位符。
- **错误回传**：参数错误通常让模型可见并自纠正；后端 auth/5xx 错误在注册层解决（隐藏工具）优于调用时报错。

### 4.4 Provider 抽象

- **配置层决定 provider，模型不选**：Hermes、OpenClaw（web）、OpenCode、Codex、Claude Code 的搜索/抓取 provider 都由环境/配置决定。
- **媒体生成暴露 `model` 参数**：Hermes（配置决定，但动态描述暴露能力）、OpenClaw（`model` 可覆盖）允许模型感知模型选择。
- **`action="list"` 自省模式**：OpenClaw 媒体生成工具支持 `action="list"`，让模型查询当前可用 provider/model/尺寸，对多 backend 场景很有参考价值。

### 4.5 Prompt / Guidelines

- **系统 prompt 教导“何时必须用工具”**：Hermes 的 `mandatory_tool_use`、`execution_discipline`；Claude Code WebSearch 强制 `Sources:`。
- **工具 description 教导“具体怎么用”**：Codex 的 `.md` description、Hermes 的 `/learn` 规范。
- **模型自省**：OpenClaw `action="list"`、Hermes 动态 schema 都是让模型自己获取当前环境能力的做法。

---

## 5. 对 grapi 接口设计的建议

基于以上对比，结合 [Tavily API 调研](./tavily-api.md) 和 [fal.ai API 调研](./fal-ai-api.md)，给出以下建议：

### 5.1 工具清单（第一版）

| 工具名                              | 能力          | 是否第一版 |
| ----------------------------------- | ------------- | ---------- |
| `web_search`                        | 联网搜索      | ✅ 第一版  |
| `web_extract`                       | 网页内容提取  | ✅ 第一版  |
| `image_generate`                    | 文生图/图生图 | ✅ 第一版  |
| `web_browse` / 浏览器自动化         | 交互式网页    | ⏸️ 后续    |
| `video_generate` / `text_to_speech` | 视频/音频生成 | ⏸️ 后续    |

### 5.2 推荐接口契约

#### `web_search`

```ts
interface WebSearchInput {
  query: string;
  max_results?: number; // default 5
  time_range?: "day" | "week" | "month" | "year";
  detail?: "basic" | "advanced"; // 映射 Tavily search_depth
}

interface WebSearchOutput {
  results: Array<{
    title: string;
    url: string;
    content: string;
    score?: number;
    publishedAt?: string;
  }>;
  answer?: string; // 若 provider 支持生成答案
  usage?: { credits?: number };
  responseTime?: number;
}
```

#### `web_extract`

```ts
interface WebExtractInput {
  urls: string[]; // tool 层可接受单 string 自动包装
  detail?: "basic" | "advanced";
  format?: "markdown" | "text"; // default 'markdown'
}

interface WebExtractOutput {
  results: Array<{
    url: string;
    title?: string;
    content: string;
    images?: string[];
    favicon?: string;
  }>;
  failed: Array<{ url: string; error: string }>;
  usage?: { credits?: number };
}
```

#### `image_generate`

```ts
interface ImageGenerateInput {
  prompt: string;
  model?: string; // e.g. "fal-ai/flux/dev"
  n?: number; // default 1
  size?: ImageSizePreset | { width: number; height: number };
  aspect_ratio?: string; // 对 Nano Banana 等模型
  output_format?: "jpeg" | "png" | "webp";
  safety?: "off" | "low" | "normal" | "strict";
  image_url?: string; // 图生图/编辑
  reference_image_urls?: string[];
}

interface ImageGenerateOutput {
  images: Array<{
    url: string; // CDN URL 或 data URI
    width?: number;
    height?: number;
    content_type?: string;
    nsfw?: boolean;
  }>;
  seed?: number;
  usage?: { estimatedCost?: number };
}
```

### 5.3 设计原则

1. **配置决定 provider，模型不选**：`WebSearchProvider`、`WebExtractProvider`、`ImageGenProvider` 由 grapi 配置/环境变量激活，工具 schema 不暴露 `provider`。
2. **缺凭证隐藏工具**：未检测到 `TAVILY_API_KEY` / `FAL_KEY` 等时，对应工具不注册，避免模型误调用。
3. **返回结构化 JSON + 溢出文件**：统一 JSON 返回；超出 token 预算时写入 `docs/research/` 或临时目录并返回路径。
4. **描述写清边界**：每个工具 description 说明“何时用、返回什么、何时不用、常见错误”。
5. **可选动态 schema**：若同一能力支持多 backend，可在 description 中追加当前激活 backend 的能力边界（如支持的 `aspect_ratio` 集合）。
6. **错误信息可自纠正**：参数错误消息中说明“请按 schema 重写”；后端错误区分“缺失凭证”（注册层解决）和“调用失败”（返回模型可读错误）。

---

## 6. 参考资料

- 各 agent 本地克隆：`
  - `/Users/grapes/coding-agents/hermes-agent`
  - `/Users/grapes/coding-agents/openclaw`
  - `/Users/grapes/coding-agents/opencode`
  - `/Users/grapes/coding-agents/codex`
  - `/Users/grapes/coding-agents/claude-code-rev`
- 子代理详细报告：
  - [Hermes 调研报告](./hermes-tools-research.md)
  - [OpenClaw 调研报告](./openclaw-tools-research.md)
  - [OpenCode 调研报告](./opencode-tools-research.md)
  - [Codex CLI 调研报告](./codex-tools-research.md)
  - [Claude Code 调研报告](./claude-code-tools-research.md)
- Provider API 调研：
  - [Tavily API 调研](./tavily-api.md)
  - [fal.ai API 调研](./fal-ai-api.md)
