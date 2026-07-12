# OpenClaw 外部能力工具调研报告

> 调研对象：`/Users/grapes/coding-agents/openclaw` 中的 OpenClaw coding agent。本报告聚焦 **web_search**、**web_fetch / extract / browse**、**image / media generation** 这三类“超出本地文件系统”的能力，分析其模型优先（model-first）设计选择。

---

## 1. Overview — 工具注册与调用机制

OpenClaw 是一个插件化 coding agent。其内置工具（built-in tools）通过工厂函数创建，并在 `createOpenClawTools()` 中组装成最终的工具清单，注入 `Agent` 运行时。

- **工具注册方式**：不是 MCP 原生协议。每个工具实现为 `AgentTool` 对象，包含 `name`、`label`、`description`、`parameters`（JSON Schema / Typebox）和 `execute()`。运行时通过函数调用（function calling）把 schema 暴露给 LLM。
- **插件补充**：`createOpenClawTools()` 还会调用 `resolveOpenClawPluginToolsForOptions()` 加载插件贡献的工具（plugins can register `tools` contracts）。
- **MCP 支持**：仓库里有 `src/mcp/` 目录，说明 OpenClaw 也支持 MCP server 接入，但本次调研的核心内置工具走的是 `AgentTool` 路径。
- **系统提示注入**：`buildEmbeddedSystemPrompt()` / `buildConfiguredAgentSystemPrompt()` 会把 `tools.map(t => t.name)` 传给 `buildAgentSystemPrompt()`，在 system prompt 的 `## Tooling` 区列出可用工具及一行摘要。
- **运行时上下文**：`createOpenClawTools()` 会注入 `runtimeWebSearch` / `runtimeWebFetch`（来自 `getActiveRuntimeWebToolsMetadata()`），并开启 `lateBindRuntimeConfig: true`，让长生命周期 agent 在不重建工具对象的情况下获取运行时凭证更新。

关键代码位置：

```ts
// src/agents/openclaw-tools.ts
const webSearchTool = createWebSearchTool({
  config: options?.config,
  agentDir: options?.agentDir,
  sandboxed: options?.sandboxed,
  runtimeWebSearch: runtimeWebTools?.search,
  lateBindRuntimeConfig: true,
});
const webFetchTool = createWebFetchTool({
  config: options?.config,
  sandboxed: options?.sandboxed,
  runtimeWebFetch: runtimeWebTools?.fetch,
  lateBindRuntimeConfig: true,
});
```

---

## 2. Tool inventory — 相关工具清单

### 2.1 `web_search` — 网络搜索

| 维度             | 内容                                                                                                                                                                                                                                                                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 工具名           | `web_search`                                                                                                                                                                                                                                                                                                                                   |
| Label            | Web Search                                                                                                                                                                                                                                                                                                                                     |
| Description      | “Search web for current info; returns normalized provider results.”                                                                                                                                                                                                                                                                            |
| 参数 schema      | 手写 JSON Schema（`WebSearchSchema`），`query` 为唯一 required 字段。可选字段：`count`（1–10，默认 5 来自 `DEFAULT_SEARCH_COUNT`）、`country`、`language`、`freshness`（day/week/month/year）、`date_after` / `date_before`、`search_lang`、`ui_lang`（Brave 专用）、`domain_filter`、`max_tokens`、`max_tokens_per_page`（Perplexity 专用）。 |
| 返回值           | 通过 `jsonResult()` 返回 JSON 字符串；顶层结构 `{ provider, ...result }`。Provider 具体返回结构由插件决定，通常包含 `results[]`、`cached` 等字段。                                                                                                                                                                                             |
| 错误处理         | 候选 provider fallback 循环：依次尝试 `resolveWebSearchCandidates()` 返回的 provider；若返回 `{ error: "missing_xxx_api_key" }` 这种结构化缺失凭证错误，在 auto-detect fallback 模式下会被视为该 provider 不可用并继续尝试下一个；最终无可用 provider 时抛出 “web_search is disabled or no provider is available.”。                           |
| 缺失配置/API key | `createWebSearchTool()` 在 `tools.web.search.enabled === false` 时返回 `null`（工具不出现在清单）。运行时若找不到任何有凭证的 provider，则抛出上述错误。                                                                                                                                                                                       |

实现核心：`src/agents/tools/web-search.ts`、`src/web-search/runtime.ts`。

### 2.2 `web_fetch` — 网页抓取 / 提取

| 维度        | 内容                                                                                                                                                                                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 工具名      | `web_fetch`                                                                                                                                                                                                                                                                                                         |
| Label       | Web Fetch                                                                                                                                                                                                                                                                                                           |
| Description | “Fetch URL and extract readable markdown/text. Lightweight page access; no browser automation.”                                                                                                                                                                                                                     |
| 参数 schema | Typebox schema（`WebFetchSchema`）：`url`（required，描述 “HTTP(S) URL.”）、`extractMode`（可选 enum `markdown` / `text`，默认 `markdown`）、`maxChars`（可选整数，≥100）。                                                                                                                                         |
| 返回值      | `jsonResult()` 返回 JSON；字段包括 `url`、`finalUrl`、`status`、`contentType`、`title`、`extractor`、`externalContent: { untrusted: true, source: "web_fetch", wrapped: true }`、`truncated`、`length`、`rawLength`、`fullOutputPath`（当内容溢出到私有临时文件时）、`fetchedAt`、`tookMs`、`text`、`warning`。     |
| 截断策略    | 默认最多返回 `DEFAULT_FETCH_MAX_CHARS = 20_000` 字符；配置级 `maxCharsCap` 可封顶。超出时会把内容写入私有临时文件（`WEB_FETCH_SPILL_MAX_CHARS = 2_000_000`），并在返回 JSON 中给出 `fullOutputPath`，提示模型可读取完整内容。                                                                                       |
| 错误处理    | - URL 协议非法抛 “Invalid URL: must be http or https”。<br>- HTTP 非 2xx 先尝试 provider fallback（如 Firecrawl），fallback 失败则读取错误响应体并截断后抛出 `Web fetch failed (status): ...`。<br>- SSRF 拦截 `SsrFBlockedError` 直接上抛。<br>- 内容提取失败（HTML 且 readability 关闭、无 provider）抛明确错误。 |
| 缺失配置    | `createWebFetchTool()` 在 `tools.web.fetch.enabled === false` 时返回 `null`；默认 enabled。                                                                                                                                                                                                                         |

实现核心：`src/agents/tools/web-fetch.ts`、`src/web-fetch/runtime.ts`、`src/web-fetch/content-extractors.runtime.ts`。

### 2.3 `image_generate` — 图像生成

| 维度        | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 工具名      | `image_generate`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Label       | Image Generation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Description | 长描述，包含背景任务说明、透明背景说明、`action="list"` / `action="status"` 用法：`'Create/edit images. Session chats: background task; do not call image_generate again for same request; wait completion, then report through the current visible-reply contract with generated media attached using structured media fields. Transparent: outputFormat="png" or "webp" + background="transparent"; OpenAI also supports openai.background and routes default model to gpt-image-1.5. Use action="list" for providers/models/readiness/auth, "status" for active task.'` |
| 参数 schema | Typebox `ImageGenerateToolSchema`，可选 `action`（generate/list/status）、`prompt`、`image` / `images`（参考图，最多 14 张）、`model`（provider/model override，如 `openai/gpt-image-2`）、`filename`、`size`、`aspectRatio`（详细枚举）、`resolution`（1K/2K/4K）、`quality`（low/medium/high/auto）、`outputFormat`（png/jpeg/webp）、`background`（transparent/opaque/auto）、`openai` 对象（background/moderation/outputCompression/user）、`fal` 对象（creativity）、`count`（1–4）、`timeoutMs`。                                                                    |
| 返回值      | 同步路径返回 `{ content: [{type:"text", text: ...}], details: { provider, model, count, media, attachments, paths, attempts, normalization, metadata, ... } }`；异步路径返回 started result，包含 task handle，提示模型等待 completion event。                                                                                                                                                                                                                                                                                                                             |
| 错误处理    | 输入校验使用 `ToolInputError`；provider/model 选择后由 `generateImage()` 按候选列表 fallback；失败会汇总 `attempts` 抛出 “All image generation models failed (N): ...”。能力不匹配在工具层提前校验（如参考图数量、count 上限）。                                                                                                                                                                                                                                                                                                                                           |
| 缺失配置    | `createImageGenerateTool()` 在 `hasGenerationToolAvailability()` 为 false 时返回 `null`（无 provider 或无 auth）。                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

实现核心：`src/agents/tools/image-generate-tool.ts`、`src/image-generation/runtime.ts`。

### 2.4 `music_generate` / `video_generate` — 音视频生成

OpenClaw 把 music 和 video generation 也作为独立内置工具暴露给模型，设计与 `image_generate` 高度同源。

- `music_generate`：参数包括 `prompt`、`lyrics`（仅在用户提供了歌词或明确要求歌词时使用）、`instrumental`、`image` / `images`、`model`、`durationSeconds`、`format`（mp3/wav）、`filename`。
- `video_generate`：参数包括 `prompt`、`image` / `images`、`video` / `videos`、`audioRef` / `audioRefs`（仅在 provider 支持 reference audio 时暴露）、`imageRoles` / `videoRoles` / `audioRoles`（位置对齐的角色数组）、`model`、`size`、`aspectRatio`、`resolution`、`durationSeconds`、`audio`、`watermark`、`providerOptions`、`timeoutMs`。

两者同样支持 `action="list"` / `action="status"`，同样走 background-task 路径（session chats 下 detach）。

实现核心：`src/agents/tools/music-generate-tool.ts`、`src/agents/tools/video-generate-tool.ts`、`src/media-generation/runtime-shared.ts`。

---

## 3. LLM-friendly patterns — 对模型友好的设计

### 3.1 命名与描述

- 工具名全小写 + 下划线：`web_search`、`web_fetch`、`image_generate`，与多数 LLM function-calling 训练分布一致。
- 描述简短、动作化，强调“返回什么”和“何时用”。例如 `web_fetch` 特意说明 “Lightweight page access; no browser automation”，暗示模型不要把它当浏览器自动化工具。
- 媒体生成工具的描述里直接写入使用模式：`action="list"` 用于查看 provider/model/auth，`action="status"` 查任务状态，transparent 背景需要 `outputFormat="png"` 或 `"webp"`。这是把“模型操作手册”直接放进 schema description。

### 3.2 参数 schema 设计

- **枚举值写进 description**：`aspectRatio`、`resolution`、`quality`、`outputFormat` 等都在 description 中列出允许值，因为 provider 差异大，模型需要明确知道可用集合。
- **通用 override 参数**：`model` 字段允许 `provider/model` 形式，让模型可以在单次调用中切换 provider，而不需要修改配置。
- **snake_case / camelCase 兼容**：`readSnakeCaseParamRaw()` 被大量使用（例如 `date_after` 与 `dateAfter` 都接受），减少模型因下划线/驼峰不一致导致的失败。
- **嵌套 provider 选项对象**：`openai: { background, moderation, outputCompression, user }`、`fal: { creativity }`，把 provider 专有选项显式隔离，避免污染顶层 schema。

### 3.3 结果塑形（result shaping）

- 统一返回 `AgentToolResult<{ content, details }>`。`content` 是模型可见的文本/图像；`details` 是结构化元数据。
- `jsonResult()` 把 details 序列化为带缩进的 JSON，既给模型看也给日志/UI 用。
- 关键元数据帮助模型 self-correct：
  - `provider` / `model`：让模型知道实际用了哪个后端。
  - `truncated` / `rawLength` / `fullOutputPath`：明确告知内容被截断及如何获取完整内容。
  - `ignoredOverrides` / `normalization`：告诉模型哪些请求参数被后端改写或忽略。
  - `attempts`：fallback 链路中每次失败的原因。

### 3.4 进度与长任务

- `web_fetch` 用 `scheduleToolProgress()` 在耗时超过 5 秒时发送 “Fetching page content...” 进度条，避免模型认为调用卡死。
- 媒体生成工具默认在 session chat 中 detach 成 background task，返回 `buildMediaGenerationStartedToolResult()`，告诉模型“任务已启动，等待 completion event，不要重复调用”。

### 3.5 自省能力

- 所有媒体生成工具和部分 web 工具支持 `action="list"`，让模型能主动查询当前有哪些 provider、是否已配置 auth、支持哪些 model/尺寸/格式。这是一种“模型可自我纠错选择 provider”的设计。

---

## 4. Provider abstraction — 多后端/provider 切换

### 4.1 Web 搜索与抓取

- Provider 以插件 contract 形式注册：`webSearchProviders`、`webFetchProviders`。
- 在 `src/web-search/runtime.ts` 和 `src/web-fetch/runtime.ts` 中，通过 `resolvePluginWebSearchProviders()` / `resolveRuntimeWebSearchProviders()` 等拿到候选列表。
- **选择逻辑**：
  1. 若 `tools.web.search.provider` / `tools.web.fetch.provider` 显式配置，则使用该 provider。
  2. 否则按“有可用凭证”的 provider 自动检测（auto-detect），并按 `sortWebSearchProvidersForAutoDetect()` / `sortWebFetchProvidersForAutoDetect()` 排序。
  3. 运行时 provider（runtime-only providers）可在 `runtimeWebSearch` / `runtimeWebFetch` 中提供，支持动态注入。
- **Fallback**：`runWebSearch()` 和 `web_fetch.runWebFetch()` 在直接请求失败或 provider 不可用时，会按候选列表 fallback。
- 调研中看到的 provider 实现位于 `extensions/`：firecrawl、google、exa、duckduckgo、parallel、moonshot 等。

### 4.2 图像/视频/音乐生成

- Provider 以 capability contract 注册：`imageGenerationProviders`、`videoGenerationProviders`、`musicGenerationProviders`。
- 核心函数 `resolveCapabilityModelCandidates()`（`src/media-generation/runtime-shared.ts`）构造候选列表：
  1. 显式 `model` override（`provider/model`）。
  2. `agents.defaults.imageGenerationModel.primary`。
  3. `agents.defaults.imageGenerationModel.fallbacks`。
  4. 自动 fallback：所有已配置 auth 且声明 defaultModel 的 provider，按当前默认 text provider 优先排序。
- 运行时 `generateImage()` / `generateVideo()` / `generateMusic()` 依次尝试候选，记录 `attempts`，最终汇总失败信息。
- 模型可以通过 `model` 参数直接指定 provider/model，也可以通过 `action="list"` 查看可选 provider。

### 4.3 对模型暴露的 provider 切换接口

- Web 工具：**不暴露** `provider` 参数给模型；provider 选择完全由配置/凭证决定。模型只能用 `model` 不是 web 工具的设计。
- 媒体生成工具：**通过 `model` 参数**暴露 provider 切换，例如 `model: "openai/gpt-image-2"` 或 `model: "google/imagen-3"`。
- 所有生成工具通过 `action="list"` 让模型查看 provider 可用性与 auth 状态，实现“模型主导选择”。

---

## 5. Prompt snippets / guidelines — 系统提示中的工具使用指导

### 5.1 系统提示工具列表

`buildAgentSystemPrompt()` 在 `## Tooling` 区列出可用工具，相关行：

```text
- web_search: Search the web using the configured provider
- web_fetch: Fetch and extract readable content from a URL
- image_generate: Generate images with the configured image-generation model
```

（`music_generate`、`video_generate` 在工具列表中也有出现，但系统提示的核心摘要字典 `coreToolSummaries` 中目前只列到 `image_generate`，可能是因为 media 区其他工具靠 description self-document。）

### 5.2 工具描述本身即 prompt

OpenClaw 没有把使用说明放在单独的 `promptSnippet`（`promptSnippet` 机制主要用在 `src/agents/sessions/tools/` 下的 read/write/edit 等文件工具），而是直接把使用指南写进 `description`：

- `image_generate` 的 description 明确告诉模型：session chats 是 background task、不要重复调用、transparent 需要 png/webp、OpenAI 默认路由到 gpt-image-1.5、`action="list"` 用法。
- `music_generate` 的 description 明确：如果用户说“make/generate/create song/music”，要调用 `music_generate`；`lyrics` 只用于精确歌词；prompt 用于风格/情绪/乐器。
- `video_generate` 的 description 明确：duration 可能会被归一化到 provider 支持的值。

### 5.3 行为准则

系统提示中还有一些通用原则间接指导工具使用：

```text
## Tool Call Style
...
First-class tool exists: use it; do not ask user to run equivalent CLI/slash command.
```

```text
## Sub-Agent Delegation
...
Delegate file/code inspection, shell commands, web/browser use, long reads, debugging, coding, multi-step analysis, comparisons, non-trivial summarization, and background waiting.
```

---

## 6. Files examined — 查阅的关键文件

### 核心工具实现

- `src/agents/tools/web-search.ts` — `web_search` 工具定义与 schema。
- `src/agents/tools/web-fetch.ts` — `web_fetch` 工具定义、schema、结果塑形、溢出策略。
- `src/agents/tools/image-generate-tool.ts` — `image_generate` 完整实现。
- `src/agents/tools/music-generate-tool.ts` — `music_generate` 实现。
- `src/agents/tools/video-generate-tool.ts` — `video_generate` 实现。
- `src/agents/tools/web-tools.ts` — web 工具 barrel。
- `src/agents/tools/common.ts` — 通用参数读取、JSON 结果、进度、图像结果。
- `src/agents/tools/tool-results.ts` — `jsonResult()` / `textResult()`。
- `src/agents/tools/media-tool-shared.ts` — 媒体工具共享逻辑（model config、能力校验、reference inputs、任务详情）。
- `src/agents/tools/media-generate-tool-actions-shared.ts` — `action="list"` / `status` 共享实现。
- `src/agents/tools/image-generate-tool.actions.ts` — image_generate list/status action。
- `src/agents/tools/web-search-provider-common.ts` — 搜索缓存、时间过滤、 freshness 归一化、错误响应。
- `src/agents/tools/web-shared.ts` — web 工具共享缓存、超时、响应读取、字符集嗅探。
- `src/agents/tools/web-fetch-utils.ts` — HTML/markdown 提取工具。
- `src/agents/tools/web-tool-runtime-context.ts` — web 工具运行时上下文解析。

### 运行时与 provider 解析

- `src/web-search/runtime.ts` — web_search provider 选择、凭证检测、fallback 执行。
- `src/web-fetch/runtime.ts` — web_fetch provider 选择、凭证检测。
- `src/web-fetch/content-extractors.runtime.ts` — 插件化 readability/content 提取桥接。
- `src/image-generation/runtime.ts` — 图像生成运行时与 fallback。
- `src/image-generation/provider-registry.ts` — 图像生成 provider 注册表。
- `src/media-generation/runtime-shared.ts` — 媒体生成共享候选解析、尺寸/分辨率/aspect ratio 归一化。

### 工具组装与系统提示

- `src/agents/openclaw-tools.ts` — `createOpenClawTools()`，组装所有内置工具。
- `src/agents/tool-catalog.ts` — 核心工具目录、profile、分组。
- `src/agents/system-prompt.ts` — `buildAgentSystemPrompt()`，注入工具列表与摘要。
- `src/agents/system-prompt-config.ts` — 配置感知的系统提示构建。
- `src/agents/embedded-agent-runner/system-prompt.ts` — 把工具名映射进系统提示参数。

### 插件与类型

- `src/plugins/types.ts` — `WebSearchProviderPlugin`、`WebFetchProviderPlugin`、provider 能力类型。
- `src/plugins/contracts/inventory/bundled-capability-metadata.ts` — bundled plugin 能力清单。
- `src/plugins/web-search-providers.runtime.ts` / `web-fetch-providers.runtime.ts` — provider 发现。
- `extensions/firecrawl/src/firecrawl-search-provider.ts` — Firecrawl web_search provider 示例。
- `extensions/firecrawl/src/firecrawl-fetch-provider.ts` — Firecrawl web_fetch provider 示例。
- `packages/agent-core/src/types.ts` — `AgentTool`、`AgentToolResult` 等运行时类型。

---

## 7. Open questions / uncertainties

1. **默认安装包含哪些 web provider？** 调研看到 `extensions/` 下有 firecrawl、google、exa、duckduckgo、parallel、moonshot 等实现，但无法确认默认打包/启用的是哪些，以及是否依赖用户主动安装插件或配置环境变量。
2. **`web_fetch` 的 provider fallback 是否总是存在？** 代码中 `maybeFetchProviderWebFetchPayload()` 只在 `resolveWebFetchDefinition()` 返回非 null 时启用；若用户未安装任何 web_fetch provider 插件，则直接 fetch 失败后没有 fallback。
3. **Codex native web_search 的注入逻辑**：`embedded-agent-runner-extraparams.test.ts` 提到对 Codex 模型会注入原生 `web_search` tool type，但本次未深入阅读该注入路径，不确定它如何与内置 `web_search` 工具并存或互斥。
4. **Provider schema normalization 对模型的影响**：`ProviderNormalizeToolSchemas` 允许 provider 插件在注册前改写 schema 关键字。某些 provider 是否会因此隐藏/重命名 `web_search` / `web_fetch` 的某些字段，需要具体 provider 实现验证。
5. **`video_generate` 的 `providerOptions` 实际接受哪些键？** schema 只说明是 provider JSON options，但具体键/类型由各 provider capabilities 决定；模型需通过 `action="list"` 才能获知。
6. **媒体生成工具在 CLI / 非 session 场景下是否 detach？** 代码中 `shouldDetachMediaGenerationTask()` 主要与 session key 相关；对于 one-shot CLI run，可能走同步路径，但本次未完全验证触发条件。

---

_报告生成时间：2026-07-12_
