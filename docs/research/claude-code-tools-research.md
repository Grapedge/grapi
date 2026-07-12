# Claude Code "越出本地文件系统" 工具研究报告

> 研究范围：以 `/Users/grapes/coding-agents/claude-code-rev`（一份通过 source map 还原的 Claude Code 源码树）为主；公开文档/常识仅作为补充，并会明确标注。

---

## 1. Overview — 工具注册与调用机制

Claude Code 的本地工具层统一由 `src/Tool.ts` 中的 `Tool<T, Output, Progress>` 接口描述，并通过 `buildTool()` 填充默认值。工具最终通过 `src/utils/api.ts` 的 `toolToAPISchema()` 转换为 Anthropic Messages API 的 `BetaToolUnion` JSON Schema，随后进入 `src/services/api/claude.ts` 的 `queryModelWithStreaming()` 调用链。

关键机制：

- **Native / 服务端工具 vs 客户端工具**：
  - `WebSearchTool` 本身是一个本地包装器，它在调用模型时额外注入 Anthropic 原生服务端工具 `web_search_20250305`（`type: 'web_search_20250305'`、`name: 'web_search'`），由模型在服务端直接完成搜索。
  - `WebFetchTool` 是完整的客户端函数调用工具：模型生成 `url` + `prompt`，本地代码执行 HTTP 抓取、HTML→Markdown 转换、再由小模型（Haiku）按 prompt 总结后返回。
- **MCP 工具**：所有 MCP server 提供的工具被统一包装成 `MCPTool`（`src/tools/MCPTool/MCPTool.ts`），运行时通过 `mcpClient.ts` 覆写 `name`、`description`、`prompt`、`call` 等字段，名字格式为 `mcp__<server>__<tool>`。浏览器自动化就是一例 MCP 能力（见第 2 节）。
- **工具模式转换**：`toolToAPISchema()` 会把 Zod v4 schema（通过 `zod/v4` 的 `toJSONSchema`）转成 JSON Schema；对 MCP 工具则直接使用其 `inputJSONSchema`。转换结果按工具名 + schema 缓存到 `toolSchemaCache`，避免 GrowthBook feature flag 波动导致 prompt cache 失效。
- **延迟加载（ToolSearch）**：`WebSearchTool` 和 `WebFetchTool` 都设置了 `shouldDefer: true`，会带 `defer_loading: true` 发送给模型；模型需要先调用 `ToolSearchTool` 加载它们，才能使用。`toolToAPISchema()` 通过 `options.deferLoading` 控制该字段。
- **细粒度工具流**：当走 Anthropic 官方 endpoint 且开启 `tengu_fgts` 时，工具 schema 会加上 `eager_input_streaming: true`，让大参数工具调用可以流式接收 `input_json_delta`。

---

## 2. Tool inventory — 相关工具清单

### 2.1 WebSearch（原生服务端搜索 + 本地包装器）

- **代码中的工具名**：本地包装器名 `WebSearch`（`src/tools/WebSearchTool/prompt.ts` 中 `WEB_SEARCH_TOOL_NAME = 'WebSearch'`）。实际下发给模型的原生工具名为 `web_search`，schema 类型 `web_search_20250305`。
- **模型看到的描述**（来自 `getWebSearchPrompt()`）：
  > - Allows Claude to search the web and use the results to inform responses
  > - Provides up-to-date information for current events and recent data
  > - Returns search result information formatted as search result blocks, including links as markdown hyperlinks
  > - Use this tool for accessing information beyond Claude's knowledge cutoff
  > - Searches are performed automatically within a single API call
  > - CRITICAL REQUIREMENT：回答后必须在 `Sources:` 部分用 markdown 超链接列出所有相关 URL。
- **参数 schema**（本地包装器，Zod `strictObject`）：
  - `query`: `string`（`min(2)`）—— 搜索查询。
  - `allowed_domains`: `string[]`，可选 —— 只返回这些域名的结果。
  - `blocked_domains`: `string[]`，可选 —— 排除这些域名。
  - 校验逻辑禁止同时出现 `allowed_domains` 和 `blocked_domains`。
  - 下发给服务端原生工具的 schema 还会附加 `max_uses: 8`。
- **返回值格式**：
  - 本地 `Output` 结构：`{ query, results: (SearchResult | string)[], durationSeconds }`。
  - `SearchResult`：`{ tool_use_id, content: [{ title, url }] }`。
  - 通过 `mapToolResultToToolResultBlockParam()` 转成一条 markdown 形式的 `tool_result`，包含查询、链接列表和强制提示：
    > "REMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks."
- **错误处理**：
  - 流式解析 `web_search_tool_result`；如果 `content` 不是数组，则记录 `Web search error: ${error_code}` 并作为错误字符串放入结果。
  - 工具调用超时/中止由 `context.abortController` 控制。
- **缺失配置 / API key**：
  - 工具是否启用由 `isEnabled()` 按 provider + model 决定（见第 4 节）。不支持的 provider/model 下，工具直接被过滤掉，模型看不到。
  - 若启用但鉴权失败，`queryModelWithStreaming()` 会把 `getAuthHeaders()` 的 `error` 或 401/403 抛给上层，通常表现为 API 错误。

### 2.2 WebFetch（本地 URL 抓取与提取）

- **代码中的工具名**：`WebFetch`（`src/tools/WebFetchTool/prompt.ts`）。
- **模型看到的描述**（来自 `DESCRIPTION`）：
  > - Fetches content from a specified URL and processes it using an AI model
  > - Takes a URL and a prompt as input
  > - Fetches the URL content, converts HTML to markdown
  > - Processes the content with the prompt using a small, fast model
  > - Returns the model's response about the content
  > - Use this tool when you need to retrieve and analyze web content
  > - 用法注意：如果 MCP 提供了 web fetch 工具，优先用 MCP；URL 必须完整；HTTP 自动升级为 HTTPS；只读；大内容会被总结；15 分钟缓存；跨主机重定向会要求用户再次调用；GitHub 链接建议用 `gh` CLI。
- **参数 schema**（Zod `strictObject`）：
  - `url`: `string`（`z.string().url()`）—— 目标 URL。
  - `prompt`: `string` —— 要对抓取内容执行的提取/总结指令。
- **返回值格式**：
  - `Output`: `{ bytes, code, codeText, result, durationMs, url }`。
  - `result` 是 Haiku 对 Markdown 内容按 `prompt` 处理后的文本；二进制内容会额外保存到磁盘，并在结果中附注路径。
  - `mapToolResultToToolResultBlockParam()` 直接把 `result` 作为 `tool_result` 文本返回。
- **错误处理**（在 `src/tools/WebFetchTool/utils.ts`）：
  - URL 校验失败（长度 > 2000、无公开可解析域名、含用户名/密码）返回 invalid URL。
  - 域名安全预检：调用 `https://api.anthropic.com/api/web/domain_info?domain=...`，`blocked` 抛 `DomainBlockedError`，`check_failed` 抛 `DomainCheckFailedError`。
  - 企业 egress 代理拦截：检测到 403 + `X-Proxy-Error: blocked-by-allowlist` 抛 `EgressBlockedError`（JSON 格式，含 `error_type: 'EGRESS_BLOCKED'`）。
  - 跨主机重定向不自动跟随，而是把 301/302/307/308 和 redirect URL 返回给模型，让模型再次调用。
  - 最多 10 次重定向，HTTP 60 秒超时，内容上限 10 MB，Markdown 截断 100,000 字符。
- **缺失配置 / API key**：
  - WebFetch 对目标站点的抓取本身不需要用户 API key。
  - 域名预检默认走 Anthropic 的 `api.anthropic.com`，但该端点似乎无需 key（代码中未附加鉴权头）。
  - 如果用户在设置里开启 `skipWebFetchPreflight`，可跳过域名预检。

### 2.3 WebBrowser / 浏览器自动化

**本地克隆中的状态**：源码树**没有**可运行的原生 `WebBrowserTool` 实现。

- `src/tools.ts` 中通过 `feature('WEB_BROWSER_TOOL')` 条件加载 `src/tools/WebBrowserTool/WebBrowserTool.js`，但 `src/tools/WebBrowserTool/` 目录下只有 `WebBrowserPanel.tsx`，且该组件直接 `return null`。
- `src/tools/WebBrowserTool/WebBrowserTool.ts` 文件不存在，因此该能力在还原后的仓库中不可用。

**最接近的等价能力**：`claude-in-chrome` bundled skill（`src/skills/bundled/claudeInChrome.ts`）。当用户安装了 Claude for Chrome 扩展并满足 `shouldAutoEnableClaudeInChrome()` 时，会暴露一组 MCP 浏览器工具，名字格式为 `mcp__claude-in-chrome__<tool>`，包括：

- `navigate`、`read_page`、`get_page_text`、`find`
- `form_input`、`computer`（鼠标键盘）、`javascript_tool`
- `tabs_context_mcp`、`tabs_create_mcp`、`resize_window`
- `upload_image`、`read_console_messages`、`read_network_requests`
- `gif_creator`、`update_plan`

这些 MCP 工具的 schema 和调用由 Chrome 扩展端的 MCP server 提供，Claude Code 本地仅做统一包装。

### 2.4 图像 / 媒体生成

**本地克隆中未实现任何 AI 图像或媒体生成工具。**

相关但非生成的模块：

- `src/tools/FileReadTool/imageProcessor.ts`：使用 `sharp` / `image-processor-napi` 对**输入图片**做缩放、格式转换、metadata 读取；另有 `getImageCreator()` 可创建纯色图片（`sharp({ create: ... })`），不是 AI 生成。
- `BriefTool`（`src/tools/BriefTool/BriefTool.ts`）支持把照片、截图等作为附件发送给用户。
- Chrome MCP 工具中有 `upload_image`（上传图片到页面）和 `gif_creator`（录制浏览器操作 GIF），都不属于 AI 图像生成。

公开文档/常识补充：Claude Code 目前不提供原生的文本到图像、文本到视频或语音生成工具；媒体能力集中在读取/处理用户已提供的图像。

---

## 3. LLM-friendly patterns — 面向模型的设计模式

1. **描述即 prompt，prompt 即规范**
   - 每个工具实现 `async prompt(options)`，返回的字符串直接作为模型看到的工具描述。描述里不只写功能，还写使用场景、注意事项、强制要求（如 WebSearch 的 `Sources:` 段落）。
   - `toolToAPISchema()` 会把这些描述缓存，避免 mid-session feature flag 变化导致 cache miss。

2. **Zod schema 即 JSON Schema**
   - 输入用 `z.strictObject({ ... })` 定义，每个字段带 `.describe('...')`。
   - 通过 `zod/v4` 原生的 `toJSONSchema()` 转换，并用 `WeakMap` 按 schema 身份缓存。
   - 对需要动态 schema 的工具（如 MCP、Workflow 的 `StructuredOutput`）提供 `inputJSONSchema`，避免 Zod 中转。

3. **延迟加载控制上下文长度**
   - `WebSearchTool` / `WebFetchTool` 都设 `shouldDefer: true`。
   - 大量 MCP 工具也可通过 `_meta['anthropic/alwaysLoad']` 或默认延迟加载，让模型先用 `ToolSearchTool` 检索需要的工具。

4. **结果再塑形（result shaping）**
   - `mapToolResultToToolResultBlockParam()` 把内部结构化输出转成模型友好的 markdown，例如 WebSearch 在结果末尾追加 "必须引用来源" 的提醒。
   - WebFetch 对非预批准域使用 Haiku 二次总结，并对引用长度、歌词、法律评论等做约束（`makeSecondaryModelPrompt()`）。

5. **细粒度权限与规则系统**
   - `checkPermissions()` 返回 `PermissionDecision`，支持 `allow`/`ask`/`deny`/`passthrough`。
   - WebFetch 按 `domain:<hostname>` 生成规则内容，用户可以按域名设置 always allow/always deny/always ask；预批准域名列表（`preapproved.ts`）包含常见编程文档站点。

6. **安全分类器输入抽象**
   - `toAutoClassifierInput()` 把工具输入映射成短字符串，供自动安全分类器使用，例如 WebFetch 返回 `"${url}: ${prompt}"`。

7. **输入校验结构化**
   - `validateInput()` 返回 `{ result: true }` 或 `{ result: false, message, errorCode, meta }`，把失败原因以模型可读的文本形式传回。

8. **并发与只读声明**
   - `isReadOnly()` / `isConcurrencySafe()` / `isDestructive()` 显式声明工具属性，调度层可据此决定是否并行执行、是否需要权限确认。

9. **UI 与模型解耦**
   - `renderToolUseMessage()` / `renderToolResultMessage()` 决定终端展示；`extractSearchText()` 控制 transcript 搜索索引内容；模型看到的是 `mapToolResultToToolResultBlockParam()` 的输出。两者可独立裁剪。

---

## 4. Provider abstraction — 同一能力的多后端切换

### 4.1 WebSearch 的 provider/model 门控

`WebSearchTool.isEnabled()`（`src/tools/WebSearchTool/WebSearchTool.ts`）明确按 provider 和模型决定是否暴露：

```ts
if (provider === "firstParty") return true;
if (provider === "vertex") {
  const supportsWebSearch =
    model.includes("claude-opus-4") ||
    model.includes("claude-sonnet-4") ||
    model.includes("claude-haiku-4");
  return supportsWebSearch;
}
if (provider === "foundry") return true;
return false;
```

这意味着：

- 在 Anthropic 官方 endpoint（firstParty）上始终可用。
- 在 Vertex AI 上只有 Claude 4 系列模型支持。
- 在 Foundry 上默认可用。
- 其他 provider（如还原版 README 提到的 `github-models`、`github-copilot` 等 OpenAI-compatible 路径）则不会把 WebSearch 加入工具列表。

### 4.2 WebFetch 的 provider 无关性

`WebFetchTool` 没有 provider 门控，所有 provider 下都可见。它依赖本地 HTTP 抓取 + Haiku 总结，不依赖 Anthropic 服务端工具，因此 provider 切换不影响其可用性（只要网络可达）。

### 4.3 MCP / Chrome 扩展作为可插拔后端

浏览器自动化没有硬编码在本体的 `WebBrowserTool` 里，而是通过 `claude-in-chrome` skill + MCP 注入。用户环境里有扩展就有浏览器工具，没有就不暴露；这本身也是一种按环境/后端动态切换能力的机制。

---

## 5. Prompt snippets / guidelines — 教模型如何使用这些工具的文本

### 5.1 WebSearch 的完整系统提示片段

来自 `src/tools/WebSearchTool/prompt.ts`：

```
- Allows Claude to search the web and use the results to inform responses
- Provides up-to-date information for current events and recent data
- Returns search result information formatted as search result blocks, including links as markdown hyperlinks
- Use this tool for accessing information beyond Claude's knowledge cutoff
- Searches are performed automatically within a single API call

CRITICAL REQUIREMENT - You MUST follow this:
  - After answering the user's question, you MUST include a "Sources:" section at the end of your response
  - In the Sources section, list all relevant URLs from the search results as markdown hyperlinks: [Title](URL)
  - This is MANDATORY - never skip including sources in your response

Usage notes:
  - Domain filtering is supported to include or block specific websites
  - Web search is only available in the US

IMPORTANT - Use the correct year in search queries:
  - The current month is <currentMonthYear>. You MUST use this year when searching for recent information ...
```

### 5.2 WebFetch 的系统提示片段

来自 `src/tools/WebFetchTool/prompt.ts` 的 `DESCRIPTION`：

```
- Fetches content from a specified URL and processes it using an AI model
- Takes a URL and a prompt as input
- Fetches the URL content, converts HTML to markdown
- Processes the content with the prompt using a small, fast model
- Returns the model's response about the content
- Use this tool when you need to retrieve and analyze web content

Usage notes:
  - IMPORTANT: If an MCP-provided web fetch tool is available, prefer using that tool instead of this one ...
  - The URL must be a fully-formed valid URL
  - HTTP URLs will be automatically upgraded to HTTPS
  - The prompt should describe what information you want to extract from the page
  - This tool is read-only and does not modify any files
  - Results may be summarized if the content is very large
  - Includes a self-cleaning 15-minute cache ...
  - When a URL redirects to a different host, the tool will inform you ... you should then make a new WebFetch request ...
  - For GitHub URLs, prefer using the gh CLI via Bash instead ...
```

### 5.3 Claude in Chrome 浏览器自动化的指导 prompt

来自 `src/utils/claudeInChrome/prompt.ts` 的 `BASE_CHROME_PROMPT`：

```
# Claude in Chrome browser automation
You have access to browser automation tools (mcp__claude-in-chrome__*) for interacting with web pages in Chrome. Follow these guidelines for effective browser automation.

## GIF recording
When performing multi-step browser interactions ... use mcp__claude-in-chrome__gif_creator ...
You must ALWAYS:
* Capture extra frames before and after taking actions ...
* Name the file meaningfully ...

## Console log debugging
... use the 'pattern' parameter with a regex-compatible pattern ...

## Alerts and dialogs
IMPORTANT: Do not trigger JavaScript alerts, confirms, prompts, or browser modal dialogs ...

## Avoid rabbit holes and loops
If ... failing after 2-3 attempts ... stop and ask the user for guidance ...

## Tab context and session startup
IMPORTANT: At the start of each browser automation session, call mcp__claude-in-chrome__tabs_context_mcp first ...
Never reuse tab IDs from a previous/other session ...
```

此外还有 `CLAUDE_IN_CHROME_SKILL_HINT`，明确告诉模型：**在使用任何 `mcp__claude-in-chrome__*` 工具前，必须先调用 `Skill` 工具并指定 `skill: "claude-in-chrome"`**。

---

## 6. Files examined — 关键文件与行号

| 文件                                           | 说明                                                            |
| ---------------------------------------------- | --------------------------------------------------------------- |
| `src/Tool.ts`                                  | `Tool` 接口、`buildTool()`、通用默认值                          |
| `src/tools.ts`                                 | 工具总装、WebBrowserTool feature flag（第 117–118、217 行附近） |
| `src/utils/api.ts`                             | `toolToAPISchema()` 转换与缓存逻辑                              |
| `src/utils/zodToJsonSchema.ts`                 | Zod v4 → JSON Schema 转换                                       |
| `src/utils/lazySchema.ts`                      | 延迟构造 schema                                                 |
| `src/services/api/claude.ts`                   | 工具 schema 注入、native `web_search` 调用流                    |
| `src/tools/WebSearchTool/WebSearchTool.ts`     | WebSearch 本地包装器、provider 门控、流式解析                   |
| `src/tools/WebSearchTool/prompt.ts`            | WebSearch 模型描述与强制来源要求                                |
| `src/tools/WebSearchTool/UI.tsx`               | WebSearch 进度与结果 UI                                         |
| `src/tools/WebFetchTool/WebFetchTool.ts`       | WebFetch 主逻辑、权限、校验                                     |
| `src/tools/WebFetchTool/prompt.ts`             | WebFetch 描述与二次总结 prompt                                  |
| `src/tools/WebFetchTool/utils.ts`              | HTTP 抓取、HTML→Markdown、缓存、错误类型                        |
| `src/tools/WebFetchTool/preapproved.ts`        | 预批准域名列表                                                  |
| `src/tools/WebBrowserTool/WebBrowserPanel.tsx` | 仅占位，返回 `null`                                             |
| `src/skills/bundled/claudeInChrome.ts`         | Chrome 浏览器自动化 skill 注册                                  |
| `src/utils/claudeInChrome/prompt.ts`           | Chrome 自动化系统提示                                           |
| `shims/ant-claude-for-chrome-mcp/index.ts`     | Chrome MCP 工具列表（恢复版 shim）                              |
| `src/tools/FileReadTool/imageProcessor.ts`     | 图片读取/处理（非生成）                                         |
| `src/tools/MCPTool/MCPTool.ts`                 | MCP 工具统一包装器                                              |
| `src/utils/http.ts`                            | WebFetch User-Agent 与鉴权头辅助                                |

---

## 7. Open questions / uncertainties

1. **WebBrowserTool 的真实形态**：本地克隆仅保留了 feature flag 和一个返回 `null` 的 panel 组件，原始 Claude Code 中的 `WebBrowserTool`（内部代号可能是 `bagel`，见 `AppStateStore.ts` 注释和 `CLAUDE_IN_CHROME_SKILL_HINT_WITH_WEBBROWSER`）具体 schema、后端（是否 Playwright/CDP/浏览器扩展）、权限模型均未知。
2. **图像/媒体生成的未来计划**：源码中没有任何 AI 图像生成工具，但公开渠道是否已有实验性能力无法从本仓库确认。
3. **WebSearch 在 Vertex/Foundry 上的实际可用性**：`isEnabled()` 逻辑来自源码，但还原仓库可能未完全复现上游 provider 检测；具体模型名匹配（如 `claude-opus-4.6` vs `claude-opus-4`）是否精确对应官方能力有待验证。
4. **WebFetch 域名预检端点**：`https://api.anthropic.com/api/web/domain_info` 在代码中以无鉴权方式调用，若该端点行为或存在性与官方不同，会影响 WebFetch 的可用性。
5. **MCP 浏览器工具的实现完整度**：`shims/ant-claude-for-chrome-mcp/index.ts` 是恢复时补的 shim，真实扩展提供的 schema、参数、错误码可能与 shim 中列出的工具名不一致。
6. **WebSearch 的原生工具返回结构**：代码中对 `web_search_tool_result` 的解析假设 `content` 为数组，但还原仓库无法实际调用官方 endpoint 验证该结构。
