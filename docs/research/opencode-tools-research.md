# OpenCode 外部能力工具调研

> 调研对象：`/Users/grapes/coding-agents/opencode`（OpenCode coding agent）。
> 调研重点：web search、web fetch / extract / browse、image / media generation 三类“跳出本地文件系统”的能力，以及面向 LLM 的设计取舍。

---

## 1. Overview

OpenCode 是一个以 Effect/TypeScript 实现的 coding agent，同时提供 CLI、Desktop、TUI 与 App 多种形态。它的工具系统分为三层：

1. **内置工具（built-in tools）**：在 `packages/opencode/src/tool/` 和 `packages/core/src/tool/` 中硬编码实现，注册进 `ToolRegistry`。
2. **插件工具（plugin tools）**：通过插件 API 注入的 Zod/JSON Schema 工具，在 `tool/registry.ts` 中被统一适配为 `Tool.Def`。
3. **MCP 工具**：通过 Model Context Protocol 连接外部服务器，`McpCatalog.convertTool` 把它们转成 `ai` SDK 的 `dynamicTool`；Code Mode（`execute` 工具）里还会把 MCP 工具暴露给一个受限 JS 解释器。

调用链路是标准 LLM function calling：

- 运行时用 `ToolRegistry.tools(...)` 根据权限、provider、model ID 过滤出可用工具列表；
- 通过 AI SDK 的 `tool(...)` / `dynamicTool(...)` 把 JSON Schema 发给模型；
- 模型返回 `tool-call` 后，由 `ToolRegistry.settle` 路由到对应的 `execute`；
- 执行结果先经过 `Truncate`（或 core 的 `ToolOutputStore`）做输出裁剪，再作为 `tool-result` 送回对话。

关键入口文件：

- `packages/opencode/src/tool/registry.ts`：注册、过滤、暴露工具给 LLM。
- `packages/opencode/src/tool/tool.ts`：`Tool.define` 与统一执行包装。
- `packages/opencode/src/mcp/catalog.ts`：把 MCP 工具定义转成模型可见的 `dynamicTool`。
- `packages/opencode/src/session/llm/request.ts`：把工具组装进 AI SDK 请求。

---

## 2. Tool inventory

### 2.1 `webfetch` —— 抓取/提取网页内容

**工具名**：`webfetch`（在 opencode 与 core 两个 package 中各有一份实现，语义几乎一致）。

**模型可见描述**（来自 `packages/opencode/src/tool/webfetch.txt`）：

```text
- Fetches content from a specified URL
- Takes a URL and optional format as input
- Fetches the URL content, converts to requested format (markdown by default)
- Returns the content in the specified format
- Use this tool when you need to retrieve and analyze web content

Usage notes:
  - IMPORTANT: if another tool is present that offers better web fetching capabilities, is more targeted to the task, or has fewer restrictions, prefer using that tool instead of this one.
  - The URL must be a fully-formed valid URL
  - HTTP URLs will be automatically upgraded to HTTPS
  - Format options: "markdown" (default), "text", or "html"
  - This tool is read-only and does not modify any files
  - Results may be summarized if the content is very large
```

`packages/core/src/tool/webfetch.ts` 中的描述更短：

```text
Fetch content from an HTTP or HTTPS URL and return it as text, markdown, or HTML. Markdown is the default.
Use a more targeted tool when one is available. This tool is read-only. Large text results may be replaced with a preview while the complete output is retained in managed storage.
```

**参数 schema**（opencode 版，`packages/opencode/src/tool/webfetch.ts`）：

```ts
export const Parameters = Schema.Struct({
  url: Schema.String.annotate({ description: "The URL to fetch content from" }),
  format: Schema.Literals(["text", "markdown", "html"])
    .annotate({
      description:
        "The format to return the content in (text, markdown, or html). Defaults to markdown.",
      default: "markdown",
    })
    .pipe(Schema.withDecodingDefault(Effect.succeed("markdown" as const))),
  timeout: Schema.optional(Schema.Number).annotate({
    description: "Optional timeout in seconds (max 120)",
  }),
});
```

core 版额外限制 `timeout` 必须 `>0 && <=120`（`Timeout = Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(MAX_TIMEOUT_SECONDS))`）。

**返回值格式**：

- **core 版**：结构化输出 `{ url, contentType, format, output }`，并配置 `toModelOutput: ({ output }) => [{ type: "text", text: output.output }]`，模型只看到纯文本。
- **opencode 版**：返回 `{ title, output, metadata, attachments? }`。如果响应是图片（`image/*`），会 base64 编码作为 `attachments: [{ type: "file", mime, url: data:<mime>;base64,... }]` 返回；文本则直接放在 `output`。

**错误处理**：

- 输入 schema 校验失败：opencode 会抛出 `InvalidArgumentsError`，消息为 `The webfetch tool was called with invalid arguments: ... Please rewrite the input ...`。
- URL 不是 `http://`/`https://`：直接拒绝（如 `file://` 会返回错误），不发起网络请求。
- 网络层错误（超时、非 2xx、超大响应体）被 `Effect.mapError` 统一收敛为 `{ type: "error", value: "Unable to fetch <url>" }`。
- 超大响应：core 使用 `collectBoundedResponseBody(response, MAX_RESPONSE_BYTES, ...)` 限制 5MB；opencode 同时检查 `content-length` 与实际 body 大小。
- 不支持的 MIME：图片与 PDF 等二进制在 core 版会被拒绝；opencode 版会把图片作为附件返回。
- Cloudflare challenge：检测到 `403 + cf-mitigated=challenge` 会用 `User-Agent: opencode` 重试一次。

**缺失配置/API key 处理**：
webfetch 不需要 API key；超时、URL 校验失败、非文本内容均作为 tool error 返回给模型。

---

### 2.2 `websearch` —— 联网搜索

**工具名**：`websearch`。

**模型可见描述**（来自 `packages/opencode/src/tool/websearch.txt`，渲染时 `{{year}}` 会被替换）：

```text
- Search the web using the session's web search provider - performs real-time web searches and can scrape content from specific URLs
- Provides up-to-date information for current events and recent data
- Supports configurable result counts and returns the content from the most relevant websites
- Use this tool for accessing information beyond knowledge cutoff
- Searches are performed automatically within a single API call

Usage notes:
  - Supports live crawling modes when available: 'fallback' (backup if cached unavailable) or 'preferred' (prioritize live crawling)
  - Search types when available: 'auto' (balanced), 'fast' (quick results), 'deep' (comprehensive search)
  - Configurable context length for optimal LLM integration
  - Domain filtering and advanced search options available

The current year is {{year}}. You MUST use this year when searching for recent information or current events
- Example: If the current year is 2026 and the user asks for "latest AI news", search for "AI news 2026", NOT "AI news 2025"
```

**参数 schema**（opencode 版，`packages/opencode/src/tool/websearch.ts`）：

```ts
export const Parameters = Schema.Struct({
  query: Schema.String.annotate({ description: "Websearch query" }),
  numResults: Schema.optional(Schema.Number).annotate({
    description: "Number of search results to return (default: 8)",
  }),
  livecrawl: Schema.optional(Schema.Literals(["fallback", "preferred"])).annotate({
    description:
      "Live crawl mode - 'fallback': use live crawling as backup if cached content unavailable, 'preferred': prioritize live crawling (default: 'fallback')",
  }),
  type: Schema.optional(Schema.Literals(["auto", "fast", "deep"])).annotate({
    description:
      "Search type - 'auto': balanced search (default), 'fast': quick results, 'deep': comprehensive search",
  }),
  contextMaxCharacters: Schema.optional(Schema.Number).annotate({
    description: "Maximum characters for context string optimized for LLMs (default: 10000)",
  }),
});
```

core 版对 `numResults`、`contextMaxCharacters` 加了上界（`MAX_NUM_RESULTS=20`、`MAX_CONTEXT_CHARACTERS=50000`），`numResults` 必须是正整数。

**返回值格式**：

- **core 版**：`Output = { provider: "exa" | "parallel", text: string }`，通过 `toModelOutput` 只把 `text` 给模型。
- **opencode 版**：`{ output, title: "Exa Web Search: <query>", metadata: { provider } }`。

**底层实现**：调用两个 MCP 风格后端：

- **Exa**：`https://mcp.exa.ai/mcp`，工具名 `web_search_exa`，参数 `{ query, type, numResults, livecrawl, contextMaxCharacters }`。若 `EXA_API_KEY` 存在则通过 query param 附带。
- **Parallel**：`https://search.parallel.ai/mcp`，工具名 `web_search`，参数 `{ objective, search_queries, session_id, model_name? }`。若 `PARALLEL_API_KEY` 存在则通过 `Authorization: Bearer ...` 附带。

请求包装为 JSON-RPC `tools/call`，响应支持普通 JSON 与 SSE `data:` 帧。

**错误处理**：

- schema 校验失败同样走 `InvalidArgumentsError`。
- MCP 响应解析失败、超时（25 秒）、响应超过 `MAX_RESPONSE_BYTES=256KB` 都会被收敛为 `{ type: "error", value: "Unable to search the web for <query>" }`。
- 空结果返回固定文案 `No search results found. Please try a different query.`。
- API key 被严格隔离在 URL/header 中，不会进入模型可见的输出（测试用例显式断言 `JSON.stringify(settled).not.toContain("parallel-secret")`）。

**缺失配置/API key 处理**：
没有显式“缺失 key 报错”。Provider 选择逻辑在 `selectWebSearchProvider` / `selectProvider` 中：

```ts
export function selectWebSearchProvider(
  sessionID: string,
  flags = { exa: false, parallel: false },
): WebSearchProvider {
  const override = process.env.OPENCODE_WEBSEARCH_PROVIDER;
  if (override === "exa" || override === "parallel") return override;
  if (flags.parallel) return "parallel";
  if (flags.exa) return "exa";

  return Number.parseInt(checksum(sessionID) ?? "0", 36) % 2 === 0 ? "exa" : "parallel";
}
```

也就是说：没有 key 时仍然按会话稳定地选择一个后端并发起请求，后端是否接受无 key 请求由服务端决定；OpenCode 本身不做前置拦截。

---

### 2.3 image / media generation —— 未实现专用工具

**结论：OpenCode 当前没有内置的“图片生成”或“媒体生成”工具。**

- `packages/opencode/src/tool/` 与 `packages/core/src/tool/` 的工具列表中均不存在 `generate_image`、`image_generation`、`dall-e`、`tts`、`video` 等工具。
- 全仓库搜索 `generateImage`、`image-generation`、`dall`、`midjourney`、`stability`、`flux` 等关键词，仅出现在 codemode 的测试示例与模型名称文案中，不是真实 agent 工具。

**最接近的等价物**：

1. **图片/媒体附件处理**：`packages/opencode/src/image/image.ts` 与 `packages/core/src/image.ts` 提供的是“图片缩放与 base64 编码”服务，用于把用户附件或工具结果里的图片规范化后送入模型上下文，而不是生成图片。
2. **从 URL 拉取图片**：opencode 版 `webfetch` 可以把图片下载并以 `data URL` 附件返回，模型可以“看到”图片，但不是生成。
3. **Kimi 系统提示中的媒体生成指令**：`packages/opencode/src/session/prompt/kimi.txt` 明确告诉模型：

   ```text
   The user may ask you to research on certain topics, process or generate certain multimedia files. When doing such tasks, you must:
   ...
   - Use proper tools or shell commands or Python packages to process or generate images, videos, PDFs, docs, spreadsheets, presentations, or other multimedia files. Detect if there are already such tools in the environment. If you have to install third-party tools/packages, you MUST ensure that they are installed in a virtual/isolated environment.
   - Once you generate or edit any images, videos or other media files, try to read it again before proceed, to ensure the the content is as expected.
   ```

   这说明生成能力被委托给外部 CLI/Python 包，而非 agent 自带工具。

4. **MCP 扩展**：任何图片/媒体生成 MCP 服务器（如 MiniMax、DALL·E MCP 等）接入后，都会通过 `execute`（Code Mode）或 MCP tool catalog 暴露给模型；但这不是 OpenCode 原生实现。

---

## 3. LLM-friendly patterns

### 3.1 命名与描述

- 内置工具使用简短、无命名空间的扁平 id：`webfetch`、`websearch`、`read`、`bash` 等。
- MCP 工具则使用 `serverName_toolName` 的命名空间前缀（`McpCatalog.toolName` 用下划线拼接并 sanitize 非法字符），避免不同服务器同名工具冲突。
- 描述分离到 `.txt` 文件（`webfetch.txt`、`websearch.txt`），便于运营文案而无需改代码；描述采用“ bullet + Usage notes”结构，直接面向模型可读。

### 3.2 Schema 设计

- 统一使用 Effect `Schema` 描述参数，字段都带 `.annotate({ description: ... })`，最终通过 `Schema.toJsonSchemaDocument` 转成 JSON Schema。
- 默认值用 `Schema.withDecodingDefault(...)` 在解码阶段补全，避免模型漏传时出现错误。
- 枚举值尽量小且语义明确：`format: ["text","markdown","html"]`、`livecrawl: ["fallback","preferred"]`、`type: ["auto","fast","deep"]`。
- 上界与类型检查在 schema 层完成（如 `PositiveInt`、`isLessThanOrEqualTo`），模型传越界值会立刻得到可读的 `InvalidArgumentsError`。
- 对 OpenAI/Responses 等严格 schema 的 provider，会强制 `strict: false`（`session/llm/request.ts`），防止 MCP/动态 schema 因不满足 structured outputs 约束而注册失败。

### 3.3 结果塑形

- 工具执行结果统一包装为 `{ title, output, metadata, attachments? }`（opencode）或 `ToolOutput`（core）。
- 通过 `toModelOutput` 控制模型最终看到的内容：webfetch/websearch 只返回文本；图片被转成 `data:` URL 附件。
- 输出截断统一走 `Truncate` 服务：超过 `max_lines=2000` / `max_bytes=50KB` 时保存完整内容到文件，返回前部预览 + 文件路径提示；提示文案会根据 `task` 工具是否可用建议模型用子代理处理长输出。core 版类似，使用 `ToolOutputStore.bound`。

### 3.4 重试与自纠正

- **Cloudflare 反爬**：webfetch 在收到 403 + `cf-mitigated=challenge` 时自动用 `User-Agent: opencode` 重试一次。
- **无效参数自纠正**：`InvalidArgumentsError.message` 明确说 `Please rewrite the input so it satisfies the expected schema`，让模型在下一轮修正。
- **递归抓取**：`beast.txt` 等系统提示要求模型“递归地用 webfetch 抓取页面中的相关链接”，把重试/深爬的决策权交给模型而非工具内部硬编码。

---

## 4. Provider abstraction

### 4.1 WebSearch 的多后端切换

WebSearch 是 OpenCode 中唯一有明显“provider 切换”逻辑的能力：

- 后端硬编码为 Exa 与 Parallel；没有通过配置暴露第三个后端。
- **没有向 LLM 暴露 provider 参数**：`websearch` 的参数 schema 里只有 `query/numResults/livecrawl/type/contextMaxCharacters`。
- 选择逻辑在服务端完成：
  1. 环境变量 `OPENCODE_WEBSEARCH_PROVIDER` 强制覆盖；
  2. runtime flags `enableExa` / `enableParallel`（由 `OPENCODE_ENABLE_EXA`、`OPENCODE_ENABLE_PARALLEL` 等环境变量控制）；
  3. 否则按 `sessionID` 的 checksum 取模二选一，保证同一会话稳定。
- 模型只能在结果 title/metadata 中知道实际用了哪个 provider（`Exa Web Search` / `Parallel Web Search`），不能主动选择。

### 4.2 MCP 作为通用 provider 扩展层

- 任意 MCP 服务器（包括可能提供搜索、图片生成、浏览器等能力）通过 `packages/opencode/src/mcp/catalog.ts` 转成 `ai` SDK 工具。
- 工具名自动加 server 前缀，模型按 `server_tool` 形式调用；Code Mode 中再映射回 `server.local` 的 JS 路径。
- MCP 后端切换/选择完全靠用户配置 `mcp` 节点实现，OpenCode 代码本身不向 LLM 暴露 provider 选择参数。

### 4.3 浏览器能力

OpenCode 没有独立的“browser”工具。`McpBrowser` 仅用于 OAuth 流程中打开浏览器完成认证，不是给模型做网页交互的工具。

---

## 5. Prompt snippets / guidelines

| 来源                                                                  | 关键指令                                                                                                                                         |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/opencode/src/session/prompt/default.txt`                    | “当用户直接问 OpenCode 相关问题时，先用 WebFetch 工具从 `https://opencode.ai` 抓取信息再回答。”                                                  |
| `packages/opencode/src/session/prompt/anthropic.txt`、`meta.txt`      | 与 default 类似，补充了“如果 WebFetch 返回重定向到不同 host，应立即用新的 redirect URL 重新 WebFetch”。                                          |
| `packages/opencode/src/session/prompt/beast.txt`                      | 强调“问题无法脱离互联网研究解决”，要求递归地用 `webfetch` 抓取用户提供的 URL 及页面内链接；并可用 `https://www.google.com/search?q=...` 做搜索。 |
| `packages/opencode/src/session/prompt/kimi.txt`                       | 通用研究/多媒体处理指南：允许用 shell/python 生成图片、视频、PDF 等；生成后必须再读取确认；强调隔离环境安装。                                    |
| `packages/opencode/src/tool/webfetch.txt`                             | 工具级说明：read-only、URL 必须合法、优先用更 targeted 的工具、结果过大可能被 summarize。                                                        |
| `packages/opencode/src/tool/websearch.txt`                            | 工具级说明：用于知识截止日期之后的信息、必须用当前年份搜索、给出 `AI news 2026` 而非 `AI news 2025` 的示例。                                     |
| `packages/core/src/tool/webfetch.ts`、`websearch.ts` 的 `description` | 直接作为 function calling 的 tool description 发给模型。                                                                                         |

---

## 6. Files examined

- `packages/opencode/src/tool/webfetch.ts` —— webfetch 实现（opencode 版）
- `packages/opencode/src/tool/webfetch.txt` —— webfetch 模型描述
- `packages/opencode/src/tool/websearch.ts` —— websearch 实现（opencode 版）
- `packages/opencode/src/tool/websearch.txt` —— websearch 模型描述
- `packages/opencode/src/tool/mcp-websearch.ts` —— Exa/Parallel MCP 调用封装
- `packages/opencode/src/tool/tool.ts` —— `Tool.define`、参数校验、执行包装
- `packages/opencode/src/tool/registry.ts` —— 工具注册、过滤、暴露给 LLM
- `packages/opencode/src/tool/truncate.ts` —— 输出截断策略
- `packages/opencode/src/mcp/index.ts` —— MCP 客户端生命周期、动态工具加载
- `packages/opencode/src/mcp/catalog.ts` —— MCP tool → AI SDK dynamicTool 转换
- `packages/opencode/src/tool/code-mode.ts` —— Code Mode 中调用 MCP 子工具
- `packages/opencode/src/session/llm/request.ts` —— 把工具列表送入 AI SDK 请求
- `packages/opencode/src/session/system.ts` —— 系统提示选择逻辑
- `packages/opencode/src/session/prompt/default.txt`、`beast.txt`、`kimi.txt`、`anthropic.txt`、`meta.txt` —— 系统提示
- `packages/opencode/src/image/image.ts` —— 图片附件缩放/规范化
- `packages/core/src/tool/webfetch.ts` —— webfetch 实现（core v2 版）
- `packages/core/src/tool/websearch.ts` —— websearch 实现（core v2 版）
- `packages/core/src/tool/tool.ts` —— core 版工具定义与 JSON Schema 生成
- `packages/core/src/tool/registry.ts` —— core v2 工具注册与 materialize
- `packages/core/src/tool-output-store.ts` —— core 版输出裁剪/持久化
- `packages/core/src/v1/config/permission.ts` —— 工具权限配置 schema
- `packages/core/test/tool-webfetch.test.ts` —— webfetch 测试用例
- `packages/core/test/tool-websearch.test.ts` —— websearch 测试用例
- `packages/llm/src/tool.ts` —— LLM Tool 抽象与 `toDefinitions`
- `packages/llm/src/schema/messages.ts` —— ToolOutput/ToolResultValue 定义

---

## 7. Open questions / uncertainties

1. **无 API key 时的真实行为**：代码中没有对 `EXA_API_KEY` / `PARALLEL_API_KEY` 缺失做前置校验，仍会对后端发起请求。这两家 MCP 端点是否允许无 key 访问、是否有配额限制，需要实际调用或阅读其 MCP 文档才能确认。
2. **MCP 是否承担 image/media generation**：OpenCode 自身无生成工具，但 MCP 生态理论上可以补充。本次调研未连接任何外部 MCP 服务器，也未找到仓库里默认打包的图像/视频生成 MCP 配置示例。
3. **webfetch 的图片附件链路**：opencode 版 webfetch 会把图片作为 file attachment 返回，但后续 `session/message-v2.ts` 对“tool result 中媒体”的支持因 provider 而异（如 Bedrock/xAI 支持图片，部分 SDK 不支持）。模型是否能稳定消费这些图片，取决于当前选用的 provider/model。
4. **websearch 的 `model_name` 字段**：Parallel 调用的参数 schema 里包含 `model_name`，但 opencode 代码中注释为 `// V2 invocation context does not safely expose the model yet`，因此未填充；这是否影响搜索结果相关性尚不明确。
5. **core 与 opencode 两个实现的长期关系**：两者并存，core 更偏向 v2 内部/headless runtime，opencode 更偏向 CLI/TUI。未来是否会统一由 core 提供 webfetch/websearch 并由 opencode 复用，代码中没有明确计划。
