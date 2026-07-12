# Codex CLI 外部能力工具调研报告

> **来源说明**：本报告主要基于 `/Users/grapes/coding-agents/codex` 本地仓库中的源码与 Markdown 描述文件。凡是引用自 OpenAI 公开文档或代码注释中提到的官方链接之处，会单独标注“公开来源”。

---

## 1. Overview — 工具注册与调用模型

**Codex CLI**（仓库核心实现为 Rust crate `codex-rs`）本身是一个运行在本地的 coding agent。它的工具系统并非 MCP（Model Context Protocol）独占，而是多层混合：

- **编译进核心的原生 handler**：例如 shell、apply_patch、view_image 等。
- **Extension / 插件机制**：`codex-web-search-extension`、`codex-image-generation-extension` 等 Rust crate 通过 `ToolContributor` 在运行时注册工具。
- **MCP 工具**：`codex-rs/core/src/tools/handlers/mcp.rs` 支持把外部 MCP server 的工具接入。
- **Hosted / 原生模型工具**：OpenAI Responses API 原生的 `web_search` 工具也会作为 `ToolSpec::WebSearch` 直接下发给模型。

工具注册链路（源码路径 `codex-rs/core/src/tools/spec_plan.rs`）：

```rust
fn add_tool_sources(...) {
    add_shell_tools(...);
    add_mcp_runtime_tools(...);
    add_core_utility_tools(...);
    add_extension_tools(...);          // web.run / image_gen.imagegen 在这里加入
    add_dynamic_tools(...);
    for spec in hosted_model_tool_specs(...) {  // 原生 web_search 在这里加入
        planned_tools.add_hosted_spec(spec);
    }
}
```

Extension 工具通过 `ExtensionToolAdapter` 把 `codex_extension_api::ToolExecutor<ExtensionToolCall>` 适配成核心 `CoreToolRuntime`（`codex-rs/core/src/tools/handlers/extension_tools.rs`）。最终所有工具被 `ToolRegistry` 按 `ToolName { namespace, name }` 索引，模型侧则序列化为 OpenAI Responses API 的 function/namespace/web_search 等 JSON 定义（`codex-rs/tools/src/tool_spec.rs` 中的 `create_tools_json_for_responses_api`）。

调用方式是**函数调用（function calling）**：模型输出 `tool_name = "web.run"` / `"image_gen.imagegen"` 及 JSON 参数，agent 本地执行后把结果写回对话上下文。

---

## 2. Tool inventory — 相关工具清单

### 2.1 `web.run` — 联网搜索 / 浏览 / 提取

- **完整工具名**：`ToolName::namespaced("web", "run")`（`codex-rs/ext/web-search/src/tool.rs:34-35`）
- **暴露方式**：Extension `codex-web-search-extension` 贡献；`ToolExposure::Direct`；支持并行调用 `supports_parallel_tool_calls() -> true`。
- **模型可见描述**：`include_str!("../web_run_description.md")`，文件开头即：
  > “Tool for accessing the internet.”
  > 后续包含大量 prompt 工程内容：命令示例、`response_length` 用法、决策边界、引用规范、字数限制、特殊情况等（见第 5 节）。
- **参数 schema**：由 `SearchCommands` 通过 `schemars` 生成，并在 `src/schema.rs` 中手动提取 `properties/required/type/additionalProperties/$defs/definitions`：

```rust
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, JsonSchema)]
pub struct SearchCommands {
    pub search_query: Option<Vec<SearchQuery>>,
    pub image_query: Option<Vec<SearchQuery>>,
    pub open: Option<Vec<OpenOperation>>,
    pub click: Option<Vec<ClickOperation>>,
    pub find: Option<Vec<FindOperation>>,
    pub screenshot: Option<Vec<ScreenshotOperation>>,
    pub finance: Option<Vec<FinanceOperation>>,
    pub weather: Option<Vec<WeatherOperation>>,
    pub sports: Option<Vec<SportsOperation>>,
    pub time: Option<Vec<TimeOperation>>,
    pub response_length: Option<SearchResponseLength>,
}

pub struct SearchQuery {
    pub q: String,
    pub recency: Option<u64>,      // 按最近 N 天过滤
    pub domains: Option<Vec<String>>,
}
```

- 所有顶层字段都是 `Option`，因此模型可以一次调用组合多个命令（例如同时 `search_query` + `finance` + `find`）。
- `SearchResponseLength` 是 enum：`short / medium / long`。
- `OpenOperation` 的 `ref_id` 既可以是 URL，也可以是之前结果中的内部引用 ID（如 `turn0search0`）。
- 关键实现：**未找到独立的 `web_extract` / `fetch` 工具**。`web.run` 的 `open`（打开页面）、`find`（页内查找）、`click`（点击链接）、`screenshot`（PDF 截图）已经覆盖了“提取/抓取/浏览”语义。

- **返回值格式**：
  - 后端返回 `SearchResponse { encrypted_output, output: String }`。
  - 本地 `SearchOutput` 直接把 `output` 作为 `FunctionCallOutputContentItem::InputText` 塞回模型（`codex-rs/ext/web-search/src/output.rs`）。
  - `contains_external_context() -> true`，因此会触发 `disable_on_external_context` 的记忆清除逻辑。
  - 请求时会带上 `max_output_tokens = call.truncation_policy.token_budget()`，但工具本身不做截断。

- **错误处理**：
  - JSON 参数解析失败：`FunctionCallError::RespondToModel(err.to_string())`（模型可见）。
  - 取 provider / auth 失败：`FunctionCallError::Fatal(err.to_string())`。
  - 后端 search 请求失败：`FunctionCallError::Fatal(err.to_string())`。

- **缺失配置 / API key 处理**：
  - 在 `WebSearchExtensionConfig::from` 中判断：
    ```rust
    available: (config.model_provider.is_openai()
        || config.model_provider.uses_openai_actor_authorization())
        && web_search_mode != WebSearchMode::Disabled
    ```
  - 不可用时直接返回空工具列表，模型根本看不到 `web.run`。
  - 若已注册但调用时无有效 auth，则 `provider.api_provider()` / `api_auth()` 返回错误并映射为 `Fatal`。

---

### 2.2 `image_gen.imagegen` — 图片生成 / 编辑

- **完整工具名**：`ToolName::namespaced("image_gen", "imagegen")`（`codex-rs/ext/image-generation/src/lib.rs`）
- **暴露方式**：Extension `codex-image-generation-extension` 贡献；`ToolExposure::Direct`。
- **模型可见描述**：`include_str!("../imagegen_description.md")`，开头：
  > “The `image_gen.imagegen` tool enables image generation from descriptions and editing of existing images based on specific instructions.”
- **参数 schema**：由 `ImagegenArgs` 生成：

```rust
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ImagegenArgs {
    prompt: String,
    #[schemars(length(max = 5))]
    referenced_image_paths: Option<Vec<AbsolutePathBuf>>,
    #[schemars(range(min = 1, max = 5))]
    num_last_images_to_include: Option<usize>,
}
```

- `prompt` 必填；两个图片引用参数互斥。
- `deny_unknown_fields` 表示 schema 会拒绝额外字段。

- **实际请求模型**：硬编码为 `const IMAGE_MODEL: &str = "gpt-image-2"`（不暴露给模型选择）。
- 若提供图片引用，则生成 `ImageEditRequest`（`/images/edits`），否则生成 `ImageGenerationRequest`（`/images/generations`）。

- **返回值格式**：
  - `GeneratedImageOutput` 把后端返回的 `b64_json` 包装成 `data:image/png;base64,...`。
  - 模型上下文返回 `FunctionCallOutputContentItem::InputImage` + 可选的 `InputText` 保存路径提示。
  - `code_mode_result()` 返回 `{"image_url": "data:image/png;base64,...", "output_hint": "..."}`，供 code-mode 的 `generatedImage()` 使用。
  - `log_preview()` 固定为 `[generated image]`，避免把 base64 写入日志。

- **错误处理**：
  - 参数解析、引用图片数超限、`referenced_image_paths` 与 `num_last_images_to_include` 同时给出、读取/处理图片失败：全部 `RespondToModel`。
  - 后端生成失败 / 无图片数据：`RespondToModel("image generation failed: ...")`。
  - 保存到本地失败：仅 `tracing::warn!`，不阻断成功结果，`saved_path` 为 `None`。

- **缺失配置 / API key 处理**：
  - 在 `ImageGenerationExtensionConfig::from_config` 中判断：
    ```rust
    available: config.model_provider.is_openai()
        || config.model_provider.requires_openai_auth
        || config.model_provider.uses_openai_actor_authorization()
    ```
  - 同时受 `ProviderCapabilities::image_generation`、`Feature::ImageGeneration`、`namespace_tools_enabled` 等控制（`spec_plan.rs`）。
  - 若已注册但 auth 缺失，`CodexImagesBackend::client()` 中 `api_provider()` / `api_auth()` 的错误会转成 `RespondToModel`。

---

### 2.3 原生 Hosted `web_search`（模型侧无参数）

当 **standalone web search extension 未启用** 且 **当前 provider 声明 `capabilities.web_search`** 时，`spec_plan.rs` 会额外下发一个原生工具：

```rust
ToolSpec::WebSearch {
    external_web_access: Some(true/false),
    indexed_web_access: Some(true), // Indexed 模式
    filters: ...,
    user_location: ...,
    search_context_size: ...,
    search_content_types: Some(["text", "image"]),
}
```

- **工具名**：`web_search`。
- **模型侧无参数**：所有搜索行为由 Responses API / 后端完成，模型只需调用 `web_search`。
- **与 `web.run` 互斥**：代码逻辑 `standalone_web_search_available` 为真时就不会再下发 hosted `web_search`。

---

### 2.4 其他“reach outside”能力

- **未发现音频/视频生成工具**：仓库中只有图片生成（`image_gen.imagegen`）。
- **未发现独立 `web_fetch` / `web_extract` 工具**：浏览/提取能力全部内聚在 `web.run` 的命令子类型中。
- `view_image` 工具（`codex-rs/core/src/tools/handlers/view_image.rs`）用于本地查看图片，不是“reach outside”工具，此处不展开。

---

## 3. LLM-friendly patterns — 面向模型的设计模式

### 3.1 命名与命名空间

- 使用 `namespace.tool` 形式：`web.run`、`image_gen.imagegen`。既避免全局命名冲突，也让模型通过点号快速识别能力域。
- Namespace 默认描述为 `"Tools in the {namespace} namespace."`（`codex-rs/tools/src/responses_api.rs`）。

### 3.2 描述（description）即 prompt

Codex 把大量**使用规范直接写进工具 description**：

- `web_run_description.md` 不是简单一句“搜索互联网”，而是包含：
  - 各子命令的 JSON 示例；
  - `response_length` 使用策略；
  - “什么情况下必须浏览互联网”的决策边界；
  - 引用格式（`[descriptive source title](https://...)`）；
  - 字数限制与版权合规提示；
  - “不小心调用 `web.run` 时空查询”的自愈提示。
- `imagegen_description.md` 则直接规定：
  - 何时该生成、何时该编辑；
  - `referenced_image_paths` 与 `num_last_images_to_include` 互斥；
  - 生成后“不要总结、不要询问、不要提下载”。

这种设计让**不同工具自带差异化 instruction**，而不是全部塞进全局 system prompt。

### 3.3 Schema 设计

- **顶层的命令聚合对象**：`web.run` 的 `SearchCommands` 把所有子能力并列成可选数组，让模型可以在一次调用中批量搜索、打开、查股价、查天气等。
- **保留字段描述**：`web.run` 使用 `parse_tool_input_schema_without_compaction` 显式保留 schemars 生成的字段 `description`，确保模型能看到每个字段含义。
- **Schema 压缩兜底**：`codex-rs/tools/src/json_schema.rs` 对过大的 schema 会做 best-effort 压缩（去 description、去 definition、折叠深层对象），但 `web.run` 选择跳过压缩以保留提示信息。
- **强类型枚举**：`FinanceAssetType`、`SportsFunction`、`SportsLeague`、`SearchResponseLength` 等均使用小写字符串枚举，减少模型拼写错误。
- **路径强校验**：`ImagegenArgs` 用 `#[serde(deny_unknown_fields)]` 和 `#[schemars(length/range)]` 限制引用图片数量。

### 3.4 结果塑形（result shaping）

- 搜索结果作为**纯文本**返回，不带复杂结构，让模型自由引用和总结。
- 图片结果直接作为 `input_image` 返回，并附加保存路径提示（`extension_image_generation_output_hint`），让模型在后续对话中能引用或编辑该图片。
- 工具输出与日志分离：`log_preview()` 返回固定占位符，避免把 base64 或长网页原文写入 telemetry。

### 3.5 自愈与错误回传

- `web.run` 的 description 明确教模型：空查询 `{}` 或 `{"search_query":[{"q":""}]}` 是合法操作，用于“误触发时收尾”。
- 参数错误、文件读取错误、后端返回空数据等大多映射为 `RespondToModel`，让模型看到可读错误并自行修正。
- 图片编辑中，若引用数量不匹配会给出具体数字提示（“requested the last N conversation images, but only M were available”）。

---

## 4. Provider abstraction — 多后端切换如何暴露给模型

核心抽象是 `codex_model_provider::SharedModelProvider`（`codex-rs/model-provider/src/provider.rs`）：

```rust
pub trait ModelProvider: Debug + Send + Sync {
    fn info(&self) -> &ModelProviderInfo;
    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            namespace_tools: true,
            image_generation: true,
            web_search: true,
        }
    }
    fn api_provider(&self) -> ... Provider;
    fn api_auth(&self) -> ... SharedAuthProvider;
    ...
}
```

- **切换方式**：由配置 `model_provider`（`ModelProviderInfo`）决定，不是模型可选择的参数。
- **能力门控**：`ProviderCapabilities` 的 `namespace_tools`、`image_generation`、`web_search` 决定哪些工具可以出现在模型可见列表中。
- `create_model_provider(provider_info, auth_manager)` 会根据 `is_amazon_bedrock()` 分支为 `AmazonBedrockModelProvider` 或默认 `ConfiguredModelProvider`。
- `web.run` 与 `image_gen.imagegen` 都通过 `provider.api_provider()` 和 `provider.api_auth()` 拿到 endpoint 与凭证，再分别构造 `SearchClient` / `ImagesClient` 发请求。
- **模型看不到 provider 切换**：它只看到自己被下发的工具集合变化。例如 Bedrock provider 可能不暴露 `web_search`，而 OpenAI provider 会暴露。

---

## 5. Prompt snippets / guidelines — 教模型使用工具的文本

### 5.1 `web_run_description.md`（节选）

```markdown
Tool for accessing the internet.

## Examples of different commands available in this tool

- `search_query`: {"search_query": [{"q": "What is the capital of France?"}]}
- `image_query`: {"image_query":[{"q": "waterfalls"}]}
- `open`: {"open": [{"ref_id": "https://www.openai.com", "lineno": 120}]}
- `click`: {"click": [{"ref_id": "turn0fetch3", "id": 17}]}
- `find`: {"find": [{"ref_id": "turn0fetch3", "pattern": "Annie Case"}]}
- `screenshot`: {"screenshot": [{"ref_id": "turn1view0", "pageno": 0}]}
- `finance`: {"finance":[{"ticker":"AMD","type":"equity","market":"USA"}]}
- `weather`: {"weather":[{"location":"San Francisco, CA"}]}

## Usage hints

- Use multiple commands and queries in one call to get more results faster
- Use "response_length" to control the number of results returned ...
- `search_query` must have length at most 4 in each call.
- If you accidentally call the `web.run` tool, send an empty query: {"search_query": [{"q": ""}]}.

## Decision boundary

... you MUST browse the internet in these cases ...

- The information could have changed recently: news, prices, laws, schedules, product specs, sports scores, political figures ...
- High-stakes accuracy matters (medical, legal, financial guidance)

## Citations

Results include internal reference IDs such as `turn2search5`. Use those reference IDs only in calls to `web.run`; do not expose them in the final response.
Cite sources in the final response using Markdown links: `[descriptive source title](https://example.com/page)`.

## Word limits

- You may not quote more than 25 words verbatim from any single non-lyrical source ...
- Each webpage source has a word limit label `[wordlim N]` ...
```

### 5.2 `imagegen_description.md`（节选）

```markdown
The `image_gen.imagegen` tool enables image generation from descriptions and editing of existing images based on specific instructions. Use it when:

- The user requests an image based on a scene description ...
- The user wants to modify an attached or previously generated image ...

Guidelines:

- Omit both `referenced_image_paths` and `num_last_images_to_include` when generating a brand new image.
- For edits, use `referenced_image_paths` when every target image has a local file path.
- If you have not seen a local image yet, use `view_image` to inspect it before editing.
- Use `num_last_images_to_include` only when at least one target image has no local file path.
- Set `num_last_images_to_include` to the smallest number of recent conversation images that includes every target image, up to 5.
- Never provide both `referenced_image_paths` and `num_last_images_to_include`.
- Directly generate the image without reconfirmation or clarification ...
- After each image generation, do not mention anything related to download. Do not summarize the image. Do not ask followup question.
```

### 5.3 图片保存路径提示（`codex-rs/core/src/context/image_generation_instructions.rs`）

```rust
format!(
    "Generated images are saved to {image_output_dir} as {image_output_path} by default.\n\
     If you need to use a generated image at another path, copy it and leave the original in place unless the user explicitly asks you to delete it."
)
```

该提示仅在路径长度 ≤ 1KB 时附加到模型输出中。

### 5.4 全局 system prompt

`codex-rs/core/gpt-5.1-codex-max_prompt.md` 与 `gpt-5.2-codex_prompt.md` 中**未出现**针对 `web.run` 或 `image_gen.imagegen` 的专门指令；所有使用规范都内聚在上述工具 description 里。

---

## 6. Files examined — 关键文件/行

| 文件                                                         | 作用                                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `codex-rs/ext/web-search/src/lib.rs`                         | Extension 注册、availability 判断                                        |
| `codex-rs/ext/web-search/src/extension.rs`                   | `WebSearchExtension` / `WebSearchExtensionConfig`、provider 与 mode 门控 |
| `codex-rs/ext/web-search/src/tool.rs`                        | `WebSearchTool` 的 `tool_name/spec/handle`、命令解析、事件发射           |
| `codex-rs/ext/web-search/src/schema.rs`                      | `SearchCommands` 的 JSON Schema 提取                                     |
| `codex-rs/ext/web-search/src/output.rs`                      | `SearchOutput` 返回值塑形                                                |
| `codex-rs/ext/web-search/src/history.rs`                     | 构造搜索请求的对话 tail                                                  |
| `codex-rs/ext/web-search/web_run_description.md`             | 模型可见完整工具说明                                                     |
| `codex-rs/ext/image-generation/src/lib.rs`                   | Extension 注册与命名空间常量                                             |
| `codex-rs/ext/image-generation/src/extension.rs`             | `ImageGenerationExtension`、availability 判断                            |
| `codex-rs/ext/image-generation/src/tool.rs`                  | `ImageGenerationTool`、参数解析、生成/编辑请求、结果塑形                 |
| `codex-rs/ext/image-generation/src/backend.rs`               | `CodexImagesBackend` 调用 Images API                                     |
| `codex-rs/ext/image-generation/imagegen_description.md`      | 模型可见图片生成说明                                                     |
| `codex-rs/codex-api/src/search.rs`                           | `SearchCommands`/`SearchRequest`/`SearchResponse` 类型定义               |
| `codex-rs/codex-api/src/endpoint/search.rs`                  | `SearchClient` POST `alpha/search`                                       |
| `codex-rs/codex-api/src/images.rs`                           | `ImageGenerationRequest`/`ImageEditRequest`/`ImageResponse`              |
| `codex-rs/codex-api/src/endpoint/images.rs`                  | `ImagesClient` POST `images/generations` / `images/edits`                |
| `codex-rs/core/src/web_search.rs`                            | `web_search_action_detail` 等显示文本构造                                |
| `codex-rs/core/src/context/image_generation_instructions.rs` | 生成图片保存路径提示                                                     |
| `codex-rs/core/src/tools/spec_plan.rs`                       | 工具装配核心：extension、hosted spec、code-mode、namespace merge         |
| `codex-rs/core/src/tools/hosted_spec.rs`                     | 原生 `ToolSpec::WebSearch` 构造                                          |
| `codex-rs/core/src/tools/registry.rs`                        | `ToolRegistry`、dispatch、hook payload                                   |
| `codex-rs/core/src/tools/handlers/extension_tools.rs`        | ExtensionToolAdapter / CoreTurnItemEmitter                               |
| `codex-rs/tools/src/tool_spec.rs`                            | `ToolSpec` 枚举、Responses API 序列化                                    |
| `codex-rs/tools/src/responses_api.rs`                        | `ResponsesApiTool` / `ResponsesApiNamespace`                             |
| `codex-rs/tools/src/json_schema.rs`                          | schema 解析、清理、压缩                                                  |
| `codex-rs/tools/src/function_call_error.rs`                  | `RespondToModel` / `Fatal` 错误模型                                      |
| `codex-rs/model-provider/src/provider.rs`                    | `ModelProvider` trait、`ProviderCapabilities`                            |
| `codex-rs/model-provider/src/auth.rs`                        | provider auth 解析                                                       |
| `codex-rs/protocol/src/config_types.rs`                      | `WebSearchMode`、`WebSearchConfig` 等配置类型                            |
| `codex-rs/protocol/src/openai_models.rs`                     | `WebSearchToolType`                                                      |
| `codex-rs/features/src/lib.rs`                               | `Feature::StandaloneWebSearch`、`Feature::ImageGeneration`               |

---

## 7. Open questions / uncertainties

1. **`web.run` 的精确生成 schema**：虽然源码类型完整，但 `schemars` 实际输出的 `required` 与 `additionalProperties` 具体值未在仓库中直接捕获；需运行时生成才能 100% 确认。
2. **搜索后端的输出结构**：`SearchResponse.output` 是纯文本字符串，但具体是 markdown、JSON 还是其他格式，以及 `encrypted_output` 的解密流程，本次未完全逆向。
3. **网络审批与扩展工具的关系**：`web.run` / `image_gen.imagegen` 直接通过 `ReqwestTransport` 发请求，未走 `ToolOrchestrator` 的 sandbox/network-approval 流程；它们是否受同样的网络策略约束，尚需进一步确认。
4. **hosted `web_search` 与 `web.run` 的共存策略**：代码中二者互斥，但某些配置下是否可能同时存在需要实测验证。
5. **图片模型不可配置**：`IMAGE_MODEL` 硬编码为 `"gpt-image-2"`，模型无法切换或指定其他图片模型。
6. **是否还有其他 reach-outside 能力**：本次只找到 `web.run` 与 `image_gen.imagegen`；若 Codex CLI 未来通过 MCP 接入了网页抓取、天气、股票等外部服务，则不在本次源码扫描范围内。
