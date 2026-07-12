# Hermes 编码 agent 外部能力工具调研报告

> 目标仓库：`/Users/grapes/coding-agents/hermes-agent`  
> 报告输出：`/Users/grapes/grapi/docs/research/hermes-tools-research.md`  
> 调研重点：web search、web extract / fetch / browse、image / video / media generation 的 LLM-first 设计。

---

## 1. Overview

Hermes 是一个 Python 实现的编码/通用 agent。工具系统采用**自注册 registry + OpenAI function calling** 模式：

- 每个 `tools/*.py` 模块在导入时调用 `tools.registry.registry.register(...)` 注册 schema、handler、availability check、emoji、动态 schema 覆盖等。
- `model_tools.py` 里的 `get_tool_definitions()` 收集 registry，返回 `{"type": "function", "function": {...}}` 列表。
- `handle_function_call()` 统一接收模型产生的 function call，先经过 `coerce_tool_args()` 类型强转，再调用 `registry.dispatch()` 执行 handler。
- 支持 MCP、插件、内置工具三来源；MCP 与插件工具在 token 过多时会被 `tool_search / tool_describe / tool_call` 桥接折叠。

关键设计点：

- 不是 MCP-first，而是**内置工具 first**；MCP 作为可选扩展。
- 每个工具可带 `check_fn`，registry 会缓存其 TTL（30s）并在失败时给一个 60s 的“grace window”，避免因为瞬时探针失败把工具从模型视野里摘掉。
- 支持 `dynamic_schema_overrides`，在 `get_tool_definitions()` 时根据当前配置/后端能力实时改写 description，让模型知道当前可用的是哪个后端、支持哪些参数。

---

## 2. Tool inventory

### 2.1 Web search

| 工具名       | 说明                                                     |
| ------------ | -------------------------------------------------------- |
| `web_search` | 通用网页搜索                                             |
| `x_search`   | X（Twitter）搜索，依赖 xAI Responses API 内置 `x_search` |

#### `web_search`

- **代码位置**：`tools/web_tools.py`（schema 在 1183–1208 行附近）
- **描述原文**：
  > "Search the web for information. Returns up to 5 results by default with titles, URLs, and descriptions. The query is passed through to the configured backend, so operators such as site:domain, filetype:pdf, intitle:word, -term, and \"exact phrase\" may work when the backend supports them."
- **参数 schema**：
  - `query`（string，required）
  - `limit`（integer，optional，default 5，min 1，max 100）
- **返回值**：JSON 字符串
  ```json
  {"success": true, "data": {"web": [{"title": ..., "url": ..., "description": ..., "position": ...}]}}
  ```
  失败时返回 `{"success": false, "error": "..."}`。
- **错误处理**：通用 `tool_error(...)`；未配置 provider 时返回 `"No web search provider configured. Run `hermes tools` to set one up."`。
- **缺失配置/Key**：`check_fn=check_web_api_key` 检测 `web.backend` / `web.search_backend` 或任意已配置后端 key；未通过时工具不会出现在模型工具列表中。

#### `x_search`

- **代码位置**：`tools/x_search_tool.py`
- **描述原文**：
  > "Search X (Twitter) posts, profiles, and threads using xAI's built-in X Search tool. Use this for current discussion, reactions, or claims on X rather than general web pages. Available when xAI credentials are configured (SuperGrok OAuth or XAI_API_KEY)."
- **参数 schema**：`query`（required），`allowed_x_handles` / `excluded_x_handles`（array，max 10），`from_date` / `to_date`（YYYY-MM-DD），`enable_image_understanding` / `enable_video_understanding`（bool）。
- **返回值**：JSON，含 `success`、`answer`、`citations`、`inline_citations`、`degraded`、`degraded_reason`。
- **错误处理**：客户端预先校验日期格式/范围；HTTP 5xx / read timeout / connection error 会重试最多 `retries` 次（默认 2）。
- **缺失配置**：`check_fn=check_x_search_requirements` 检测 xAI OAuth 或 `XAI_API_KEY`；未通过时不暴露工具。

### 2.2 Web extract / fetch / browse

| 工具名                                                                                                                                                                                         | 说明                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `web_extract`                                                                                                                                                                                  | 后端抓取/提取网页正文（markdown），无 LLM 摘要                                                          |
| `browser_navigate` / `browser_snapshot` / `browser_click` / `browser_type` / `browser_scroll` / `browser_back` / `browser_press` / `browser_get_images` / `browser_vision` / `browser_console` | 浏览器自动化（本地 Chromium / Lightpanda / 云端 Browserbase / Browser Use / Firecrawl / Camofox / CDP） |
| `browser_cdp`                                                                                                                                                                                  | 原始 Chrome DevTools Protocol 调用                                                                      |
| `browser_dialog`                                                                                                                                                                               | 处理浏览器弹窗                                                                                          |

#### `web_extract`

- **代码位置**：`tools/web_tools.py`（schema 在 1210–1239 行附近）
- **描述原文**：
  > "Extract content from web page URLs. Returns clean page content in markdown/text (no LLM summarization — fast). Also works with PDF URLs (arxiv papers, documents) — pass the PDF link directly. Pages within the char budget (default 15000) return whole; larger pages return a head+tail window with a footer telling you the full text's saved file path and the read_file call to page through the omitted middle. Inline images appear as [IMAGE: alt] placeholders; real image URLs are kept as links. If a URL fails or times out, use the browser tool instead."
- **参数 schema**：
  - `urls`（array of string，required，maxItems 5）
  - `char_limit`（integer，optional，min 2000）
- **返回值**：JSON
  ```json
  {"results": [{"url": ..., "title": ..., "content": ..., "error": ...}]}
  ```
- **结果整形**：
  - 默认 `DEFAULT_EXTRACT_CHAR_LIMIT = 15000`，可通过 `web.extract_char_limit` 配置。
  - 超长内容做 head+tail 截断（约 75%/25%），并把完整文本写入 `~/.hermes/cache/web/...md`，在 footer 中告诉模型如何用 `read_file` 翻页。
  - 内联 base64 图片被替换为 `[IMAGE: alt]` 占位符，防止 token 爆炸。
  - 结果会经过 `<untrusted_tool_result>` 包装，标记为不可信外部数据。
- **错误处理**：
  - SSRF 防护：`async_is_safe_url(url)` 会拦截私有/内网地址。
  - URL 中若包含疑似 API key/token 的参数会被拒绝。
  - 失败时返回 `tool_error("Content was inaccessible or not found")` 或具体后端错误。
- **缺失配置**：同 `web_search`，`check_fn=check_web_api_key`；若后端不支持 extract（如 brave-free/ddgs/searxng），会显式报错 `"X is a search-only backend and cannot extract URL content..."`。

#### 浏览器工具组

- **代码位置**：`tools/browser_tool.py`（schema 在 1819–2066 行；注册在 4722–4803 行）
- **工具清单与描述摘要**：
  - `browser_navigate`: "Navigate to a URL... For simple information retrieval, prefer web_search or web_extract (faster, cheaper). ... Use browser tools when you need to interact with a page (click, fill forms, dynamic content)."
  - `browser_snapshot`: 返回 accessibility tree 文本快照，含 ref IDs（`@e1`），`full=true` 时完整内容；超过 8000 字符会截断或 LLM 摘要。
  - `browser_click` / `browser_type` / `browser_scroll` / `browser_back` / `browser_press` / `browser_get_images` / `browser_console`：标准交互。
  - `browser_vision`: 截图，若当前模型无 vision 则 fallback 到辅助 vision 模型；返回 `MEDIA:<screenshot_path>`。
- **参数 schema**：
  - `browser_navigate`: `url`（string，required）
  - `browser_snapshot`: `full`（bool，default false）
  - `browser_click`: `ref`（string，如 `@e5`）
  - `browser_type`: `ref`, `text`
  - `browser_scroll`: `direction`（enum `["up", "down"]`）
  - `browser_press`: `key`（string）
  - `browser_vision`: `question`（required），`annotate`（bool）
  - `browser_console`: `clear`（bool），`expression`（string，可执行 JS）
- **返回值**：JSON，通常 `{"success": true/false, "data": {...}, "error": ...}`；截图路径在 `data.screenshot_path`。
- **错误处理**：
  - 本地模式要求 `agent-browser` CLI 与 Chromium；云端模式要求对应 provider 凭证；CDP override 可绕过本地安装。
  - `check_browser_requirements()` 会检测 local/cloud/CDP/Camofox 条件。
  - `browser_vision` 单独使用 `check_browser_vision_requirements()`，额外要求 vision 后端可用。
- **缺失配置**：
  - 本地：未安装 `agent-browser` 或 Chromium 时 `check_fn` 返回 False，工具不暴露。
  - 云端：未设置 `BROWSERBASE_API_KEY` / `BROWSER_USE_API_KEY` 等时 `provider.is_configured()` 为 False。

### 2.3 Image / video / media generation

| 工具名             | 说明                                      |
| ------------------ | ----------------------------------------- |
| `image_generate`   | 文生图 / 图生图 / 图像编辑                |
| `video_generate`   | 文生视频 / 图生视频 / reference-to-video  |
| `xai_video_edit`   | xAI Imagine 视频编辑（provider-specific） |
| `xai_video_extend` | xAI Imagine 视频延长（provider-specific） |
| `text_to_speech`   | 文本转语音                                |

#### `image_generate`

- **代码位置**：`tools/image_generation_tool.py`
- **描述（动态构建）**：基础 placeholder 描述在 schema 中，真实描述由 `dynamic_schema_overrides=_build_dynamic_image_schema()` 在 `get_tool_definitions()` 时替换，会写明当前 backend 与模型是否支持 text-to-image / image-to-image / editing。
- **基础描述原文**：
  > "Generate high-quality images from text prompts (text-to-image), or edit / transform an existing image (image-to-image) when the active model supports it. Pass `image_url` to edit that image; add `reference_image_urls` for style/composition references; omit both for text-to-image. The underlying backend (FAL, OpenAI, xAI, etc.) and model are user-configured and not selectable by the agent. ..."
- **参数 schema**：
  - `prompt`（string，required）
  - `aspect_ratio`（enum `["landscape", "square", "portrait"]`，default `"landscape"`）
  - `image_url`（string，optional，用于图生图/编辑）
  - `reference_image_urls`（array of string，optional，参考图）
- **返回值**：JSON
  ```json
  { "success": true, "image": "<url or path>", "modality": "text|image" }
  ```
  失败时 `{"success": false, "image": null, "error": ..., "error_type": ...}`。
- **后端路由**：
  - 默认走内置 FAL 多模型 catalog（`FAL_MODELS`）。
  - 若 `image_gen.provider` 显式设置，则通过 `agent.image_gen_registry` 路由到插件（`plugins/image_gen/{fal,openai,xai,krea,openrouter,...}`）。
  - 若模型声明 `edit_endpoint` 且调用方传入 source images，则自动走 image-to-image；否则走 text-to-image。
- **缺失配置**：`check_fn=check_image_generation_requirements` 检测 `FAL_KEY` 或 managed gateway 或任意可用插件 provider；均不可用时工具不暴露。

#### `video_generate`

- **代码位置**：`tools/video_generation_tool.py`
- **描述（动态构建）**：`_build_dynamic_video_schema()` 根据当前 `video_gen.provider` / model capabilities 在 description 中附加：支持 modalities、aspect_ratio 集合、resolution 集合、durations 范围、audio/negative_prompt 支持、reference 上限等。
- **基础描述原文**：
  > "Generate a video from a text prompt (text-to-video), animate a still image (image-to-video), or guide generation with reference images. Pass `image_url` to animate an image or `reference_image_urls` for reference-to-video. ... The backend and model family are user-configured via `hermes tools` → Video Generation; the agent does not pick them. ..."
- **参数 schema**：
  - `prompt`（string，required）
  - `image_url`（string，optional）
  - `reference_image_urls`（array of string）
  - `duration`（integer）
  - `aspect_ratio`（enum COMMON_ASPECT_RATIOS，default `"16:9"`）
  - `resolution`（enum COMMON_RESOLUTIONS，default `"720p"`）
  - `negative_prompt`（string）
  - `audio`（bool）
  - `seed`（integer）
  - `model`（string，可覆盖当前配置）
- **返回值**：JSON，形如 `{"success": true, "video": "<url/path>", "model": ..., "modality": "text|image", ...}`。
- **后端路由**：完全依赖插件 registry `agent.video_gen_registry`，内置无 provider。当前仓库内置 `plugins/video_gen/fal/`、`plugins/video_gen/xai/`。
- **缺失配置**：未配置 provider 时返回 `"No video generation backend is configured. Run `hermes tools` → Video Generation to enable one (xAI, FAL, or Google Veo)."`

#### `xai_video_edit` / `xai_video_extend`

- **代码位置**：`tools/xai_video_tools.py`
- **用途**：xAI Imagine 视频的编辑与延长，独立于通用 `video_generate`。
- **参数**：`prompt`（required）、`video_url`（required，必须是公开 HTTPS MP4 URL，来自前一次 Imagine 结果的 `video`/`public_url`）、`model` / `duration`（extend）。
- **缺失配置**：`video_gen.provider` 必须等于 `"xai"` 且 `has_xai_video_credentials()` 为真，否则工具不暴露。

#### `text_to_speech`

- **代码位置**：`tools/tts_tool.py`（schema 在 2842 行）
- **描述原文**：
  > "Convert text to speech audio. Returns a MEDIA: path that the platform delivers as native audio. ... Voice and provider are user-configured (built-in providers like edge/openai or custom command providers under tts.providers.<name>), not model-selected."
- **参数 schema**：`text`（required），`output_path`（optional）。
- **后端**：Edge TTS（免费）、OpenAI、xAI、ElevenLabs、MiniMax 等，通过 `tts.providers.<name>` 配置；模型不可选 provider。

---

## 3. LLM-friendly patterns

### 3.1 命名与 schema 设计

- **命名**：全部 snake_case，带领域前缀，例如 `web_search`、`browser_navigate`、`image_generate`、`video_generate`。同名工具在不同上下文不会出现歧义。
- **描述风格**：
  - 直接说明“返回什么”，例如 "Returns up to 5 results..."
  - 明确使用时机与回退： `"For simple information retrieval, prefer web_search or web_extract (faster, cheaper)."`
  - 说明跨工具依赖： `"Requires browser_navigate first"`。
- **参数**：
  - 用 enum 限制离散选择（`aspect_ratio`、`direction`）。
  - 默认值写在 description 里，也在 schema 中提供 `default`。
  - 数组限制 `maxItems`（如 `urls` 最多 5 个、`reference_image_urls` 由 provider 声明上限）。

### 3.2 动态 schema（dynamic_schema_overrides）

Hermes 把后端选择隐藏在配置里，但**不会让模型盲猜**。`image_generate`、`video_generate`、`delegate_task` 等工具注册时带 `dynamic_schema_overrides` callable，在 `get_tool_definitions()` 时把当前 backend/model 的真实能力写进 description：

```python
registry.register(
    name="image_generate",
    ...
    dynamic_schema_overrides=_build_dynamic_image_schema,
)
```

例如动态描述会追加：

> "Active backend: FAL.ai · model: FLUX 2 Klein 9B
>
> - supports both text-to-image (omit image_url) and image-to-image / editing (pass image_url) — routes automatically"

这样模型一次调用就能拿到正确参数，避免“传了 image_url 但当前模型不支持编辑”的浪费。

### 3.3 结果整形与 token 控制

- **JSON 统一**：绝大多数工具返回 JSON 字符串；成功/失败都带 `success` 与 `error`。
- **截断策略**：
  - `web_extract`：默认 15k 字符，超长做 head+tail 截断并给出 `read_file` 分页指令。
  - `browser_snapshot`：超过 8000 字符会截断或 LLM 摘要。
  - 全局 `budget_config.py` 按模型 context window 动态计算单结果/单 turn 上限（默认 100k/200k 字符）。
- **base64 去炸弹**：`convert_base64_images_to_links()` 把内联 base64 图替换成 `[IMAGE: alt]`。
- **不可信数据包装**：`agent/tool_dispatch_helpers.py` 对 `web_extract`、`web_search`、`browser_*`、`mcp_*` 的输出包裹 `<untrusted_tool_result>`，并替换内部 delimiter 防止注入逃逸。
- **Debug session**：`tools/debug_helpers.py` 的 `DebugSession` 在 `WEB_TOOLS_DEBUG=true` / `IMAGE_TOOLS_DEBUG=true` 时把每次调用参数、结果、截断指标写入 `logs/web_tools_debug_UUID.json`。

### 3.4 参数容错与自修正支持

- `model_tools.py` 的 `coerce_tool_args()` 会把模型常犯的字符串类型错误转成正确类型：
  - `"42"` → `42`
  - `"true"` → `True`
  - 单个字符串自动包成数组（`{"urls": "https://a.com"}` → `{"urls": ["https://a.com"]}`）
  - 嵌套 JSON 字符串会被递归解析。
- 错误信息通常包含可操作建议：
  - `"No web search provider configured. Run `hermes tools` to set one up."`
  - `"Provider 'x' does not support image-to-image / editing... Omit image_url for text-to-image..."`
- 系统 prompt 也教导模型："If a tool returns empty or partial results, retry with a different query or strategy before giving up."

### 3.5 可用性缓存

`tools/registry.py` 对 `check_fn` 结果做 30s TTL 缓存，并保留最近 60s 的“last good”结果。这样 Docker daemon / playwright / 后端探针短暂抖动不会把工具从模型工具列表里移除。

---

## 4. Provider abstraction

Hermes 对同一能力使用**插件化 provider registry**，但关键决策点是：

> **后端选择由配置决定，模型不选 provider。**

各能力的配置键与 registry：

| 能力                 | 配置键                                                     | Registry                            | 说明                                                                                                                                      |
| -------------------- | ---------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Web search / extract | `web.backend`、`web.search_backend`、`web.extract_backend` | `agent/web_search_registry.py`      | `_resolve()` 按显式配置 → 单可用 provider shortcut → legacy 偏好顺序（firecrawl → parallel → tavily → exa → searxng → brave-free → ddgs） |
| Image generation     | `image_gen.provider`                                       | `agent/image_gen_registry.py`       | 显式配置优先；否则若只有一个可用 provider 或 `fal` 可用则选之                                                                             |
| Video generation     | `video_gen.provider`                                       | `agent/video_gen_registry.py`       | 必须显式配置或只有一个可用 provider                                                                                                       |
| Browser              | `browser.cloud_provider`                                   | `agent/browser_registry.py`         | `local` / `browserbase` / `browser-use` / `firecrawl`，也支持 CDP override、Camofox                                                       |
| TTS                  | `tts.providers.<name>`                                     | 非统一 registry，内部 provider 列表 | 模型只传 `text`，后端由配置决定                                                                                                           |

Provider 接口定义：

- `agent/web_search_provider.py`：`WebSearchProvider` ABC，要求 `name`、`is_available()`、`search()` / `extract()`，可选 `supports_search` / `supports_extract`。
- `agent/image_gen_provider.py`：`ImageGenProvider` ABC，要求 `generate(...)`，提供 `capabilities()` 返回 `{"modalities": ["text","image"], "max_reference_images": N}`。
- `agent/video_gen_provider.py`：`VideoGenProvider` ABC，要求 `generate(...)`，提供 `capabilities()` 返回 modalities、aspect_ratios、resolutions、durations、audio/negative_prompt 支持等。
- `agent/browser_provider.py`：`BrowserProvider` ABC，要求 `create_session` / `close_session` / `emergency_cleanup`。

**对模型可见的切换方式**：模型看不到 provider 列表，但动态 schema 会告诉它当前 active backend 与 model 的能力边界。例如 `video_generate` 的 description 会列出 `"- aspect_ratio choices: 16:9, 9:16, 1:1..."`，让模型根据当前后端正确传参。

---

## 5. Prompt snippets / guidelines

系统 prompt 中直接教授模型何时/如何使用这些外部工具的片段：

### 5.1 强制使用工具（`agent/prompt_builder.py` 385–442 行）

```text
# Execution discipline
<tool_persistence>
- Use tools whenever they improve correctness, completeness, or grounding.
- Do not stop early when another tool call would materially improve the result.
- If a tool returns empty or partial results, retry with a different query or strategy before giving up.
- Keep calling tools until: (1) the task is complete, AND (2) you have verified the result.
</tool_persistence>

<mandatory_tool_use>
NEVER answer these from memory or mental computation — ALWAYS use a tool:
...
- Current facts (weather, news, versions) → use web_search
...
</mandatory_tool_use>
```

### 5.2 缺失上下文（`agent/prompt_builder.py` 435–441 行）

```text
- If required context is missing, do NOT guess or hallucinate an answer.
- Use the appropriate lookup tool when missing information is retrievable (search_files, web_search, read_file, etc.).
- Ask a clarifying question only when the information cannot be retrieved by tools.
```

### 5.3 并行调用（`agent/prompt_builder.py` 363–377 行）

```text
# Parallel tool calls
When you need several pieces of information that don't depend on each other, request them together in a single response instead of one tool call per turn. Independent reads, searches, web fetches, and read-only commands should be batched into the same assistant turn ...
```

### 5.4 Nous subscription 能力块（`agent/prompt_builder.py` 1681–1715 行附近）

```text
# Nous Subscription
Nous subscription includes managed web tools (Firecrawl), image generation (FAL), OpenAI TTS, OpenAI Whisper STT, and browser automation (Browser Use) by default. Modal execution is optional.
...
When a Nous-managed feature is active, do not ask the user for Firecrawl, FAL, OpenAI TTS, OpenAI Whisper, or Browser-Use API keys.
```

### 5.5 `/learn` skill 写作规范（`agent/learn_prompt.py`）

```text
- Reference Hermes tools by name in backticks: `terminal`, `read_file`, `write_file`, `search_files`, `patch`, `web_extract`, `web_search`, `vision_analyze`, `browser_navigate`, `delegate_task`, `image_generate`, `text_to_speech`, `cronjob`, `memory`, `skill_view`, `execute_code`.
- Do NOT name shell utilities the agent already has wrapped: say `read_file` not cat/head/tail, `search_files` not grep/rg/find/ls, `patch` not sed/awk, `web_extract` not curl-to-scrape, `write_file` not echo>file or heredocs.
```

### 5.6 工具描述本身也是 prompt

每个工具的 `description` 都承担教学职责：

- `web_extract` 告诉模型“如果失败或超时，改用 browser 工具”。
- `browser_navigate` 告诉模型“简单信息检索优先用 web_search / web_extract”。
- `image_generate` / `video_generate` 动态描述会写明当前模型是否支持 image-to-image / editing。

---

## 6. Files examined

| 文件                             | 关键行号 / 内容                                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `tools/web_tools.py`             | 1–1239：web_search / web_extract 实现、后端选择、SSRF、截断、base64 转换、schema 注册                 |
| `tools/browser_tool.py`          | 1819–2066：10 个浏览器工具 schema；4579–4639：`check_browser_requirements`；4722–4803：registry 注册  |
| `tools/browser_cdp_tool.py`      | 539–680：`browser_cdp` schema 与注册                                                                  |
| `tools/browser_dialog_tool.py`   | 28–150：`browser_dialog` schema 与注册                                                                |
| `tools/image_generation_tool.py` | 1–1681：FAL 多模型 catalog、动态 schema、插件路由、managed gateway                                    |
| `tools/video_generation_tool.py` | 1–约 500：video_generate 统一接口、动态 schema、插件 registry                                         |
| `tools/xai_video_tools.py`       | 1–170：xAI 视频编辑/延长工具                                                                          |
| `tools/x_search_tool.py`         | 1–约 340：X 搜索、日期校验、降级检测、重试                                                            |
| `tools/tts_tool.py`              | 2842–2870：`text_to_speech` schema                                                                    |
| `tools/registry.py`              | 1–全文件：自注册 registry、`check_fn` TTL/失败 grace、动态 schema 覆盖、dispatch                      |
| `model_tools.py`                 | 1–约 1382：`get_tool_definitions`、`handle_function_call`、参数 coercion、错误清洗、工具搜索桥接      |
| `agent/web_search_provider.py`   | WebSearchProvider ABC                                                                                 |
| `agent/web_search_registry.py`   | provider 注册与 active 选择逻辑                                                                       |
| `agent/image_gen_provider.py`    | ImageGenProvider ABC                                                                                  |
| `agent/image_gen_registry.py`    | image_gen provider 注册与选择                                                                         |
| `agent/video_gen_provider.py`    | VideoGenProvider ABC                                                                                  |
| `agent/video_gen_registry.py`    | video_gen provider 注册与选择                                                                         |
| `agent/browser_provider.py`      | BrowserProvider ABC                                                                                   |
| `agent/prompt_builder.py`        | 285–442：tool-use enforcement / execution discipline / parallel calls；1681：Nous subscription prompt |
| `agent/learn_prompt.py`          | `/learn` 写作规范与工具命名约定                                                                       |
| `agent/tool_dispatch_helpers.py` | 360–470：不可信工具结果包装、威胁扫描                                                                 |
| `tools/budget_config.py`         | 工具结果持久化预算、按 context window 缩放                                                            |
| `toolsets.py`                    | 97、132、138、172：web / image_gen / video_gen / browser toolset 定义                                 |

---

## 7. Open questions / uncertainties

1. **插件 provider 的具体实现细节未逐行核对**：例如 `plugins/web/firecrawl/provider.py`、`plugins/image_gen/openai/provider.py` 的 `generate()` 内部错误码、是否对 `reference_image_urls` 做额外裁剪，只看了 ABC 与主调用路径。
2. **xAI 文生图是否存在独立工具？** 仓库有 `plugins/image_gen/xai/`，但 agent 面统一走 `image_generate`；未确认 xAI Imagine 图像是否还有 provider-specific 编辑/扩展工具。
3. **浏览器 snapshot LLM 摘要的具体模型与阈值**：代码提到超过 8000 字符会截断或 LLM 摘要，但未追查具体调用模型与 prompt。
4. **TTS 多 provider 切换的完整路径**：`tts_tool.py` 很长（>2800 行），只读取了 schema 与注册部分，provider 选择逻辑未完全展开。
5. **Codex / xAI Responses 原生 web_search 替换逻辑**：`transports/codex.py` 会把客户端 `web_search` 替换为 xAI 原生 `{"type": "web_search"}`，这部分属于 transport 层，未作为 tool 设计主体展开。
6. **Hermes 是否有“audio generation” 或 music generation 工具？** 只看到 `text_to_speech` 与 `skills/media/heartmula` 等 skill；没有内置音乐生成工具，不确定是否由 skill 或 MCP 补齐。

---

_报告结束。_
