# Tavily SDK Wire 契约（fetch 封装参考）

> 来源：官方 JS SDK `@tavily/core` v0.7.6 源码（`src/utils.ts` / `search.ts` / `extract.ts` / `errors.ts`），
> 交叉核对 https://docs.tavily.com/sdk/javascript/reference.md。
> 用途：为本地 fetch 客户端（只封装 search / extract）提供精确 HTTP 契约。
> **重要**：SDK reference.md 表格用的是 camelCase（`maxResults`/`responseTime`/`rawContent`），
> 那是 **SDK 方法签名与 SDK 返回对象**的命名；实际 HTTP wire（请求体 + 响应体）一律 **snake_case**。
> 现有 `docs/research/tavily-api.md` 中"或在 body 传 `api_key`"的说法仅见于早期 REST 文档，
> 官方 SDK **不**这么做——fetch 客户端应只用 `Authorization: Bearer`。

## 1. 认证与 Base URL（来自 `utils.ts`）

- Base URL 默认 `https://api.tavily.com`；SDK 支持 `apiBaseURL` 选项自定义。
- URL 拼接：`${apiBaseURL || BASE_URL}/${endpoint}` → `/search`、`/extract`。
- 有 key：header `Authorization: Bearer <TAVILY_API_KEY>` + `Content-Type: application/json`。
- keyless（无 key）：header `X-Tavily-Access-Mode: keyless`（grapi 不用）。
- 其它可选 header（grapi 不需要）：`X-Client-Source`、`X-Project-ID`、`X-Tavily-Orgid`、`X-Session-Id`、`X-Human-Id`、`X-Client-Name`。
- **不在 body 传 `api_key`**。

## 2. search 端点

- `POST https://api.tavily.com/search`
- 请求体（snake_case）：
  - **必填**：`query: string`
  - 我们关心：`max_results: number`（默认 5，0–20）
  - 可选且**我们不会用到**：`search_depth`、`topic`、`time_range`、`start_date`、`end_date`、`include_answer`、`include_raw_content`、`include_images`、`include_image_descriptions`、`include_domains`、`exclude_domains`、`chunks_per_source`、`country`、`auto_parameters`、`include_favicon`、`include_usage`、`exact_match`、`days`、`timeout`
- 响应体字段（snake_case）：

| 字段                       | 类型             | 说明                     |
| -------------------------- | ---------------- | ------------------------ |
| `query`                    | string           | 回显查询                 |
| `results[]`                | array            | 按相关度排序             |
| `results[].title`          | string           |                          |
| `results[].url`            | string           |                          |
| `results[].content`        | string           | 摘要片段                 |
| `results[].score`          | number           | 相关度                   |
| `results[].raw_content`    | string?          | 需 `include_raw_content` |
| `results[].published_date` | string?          | topic=news 时            |
| `results[].favicon`        | string?          | 需 `include_favicon`     |
| `answer`                   | string?          | 需 `include_answer`      |
| `images`                   | array?           | 需 `include_images`      |
| `response_time`            | number \| string | **类型不稳定**（见 §5）  |
| `request_id`               | string           |                          |
| `usage`                    | object?          | 需 `include_usage`       |
| `auto_parameters`          | object?          |                          |

最小请求示例：

```json
{ "query": "Who is Leo Messi?", "max_results": 5 }
```

最小响应示例：

```json
{
  "query": "Who is Leo Messi?",
  "results": [{ "title": "...", "url": "https://...", "content": "...", "score": 0.95 }],
  "response_time": 1.67,
  "request_id": "abc123"
}
```

## 3. extract 端点

- `POST https://api.tavily.com/extract`
- 请求体（snake_case）：
  - **必填**：`urls: string[]`（数组，最多 20 个）
  - 我们关心：`format: "markdown" | "text"`（默认 `markdown`）
  - 可选且**我们不会用到**：`extract_depth`、`include_images`、`include_favicon`、`include_usage`、`query`、`chunks_per_source`、`timeout`
- 响应体字段（snake_case）：

| 字段                     | 类型             | 说明            |
| ------------------------ | ---------------- | --------------- |
| `results[]`              | array            | 成功提取        |
| `results[].url`          | string           |                 |
| `results[].title`        | string?          | SDK v0.7.6 读取 |
| `results[].raw_content`  | string           | 正文            |
| `results[].images`       | string[]?        |                 |
| `results[].favicon`      | string?          |                 |
| `failed_results[]`       | array            | 部分失败        |
| `failed_results[].url`   | string           |                 |
| `failed_results[].error` | string           |                 |
| `response_time`          | number \| string |                 |
| `request_id`             | string           |                 |
| `usage`                  | object?          |                 |

最小请求示例：

```json
{ "urls": ["https://en.wikipedia.org/wiki/Artificial_intelligence"], "format": "markdown" }
```

最小响应示例：

```json
{
  "results": [
    {
      "url": "https://en.wikipedia.org/wiki/Artificial_intelligence",
      "raw_content": "Artificial intelligence (AI) is..."
    }
  ],
  "failed_results": [],
  "response_time": 1.23,
  "request_id": "abc123"
}
```

> 设计要点：extract 是**部分成功**语义——失败的 URL 进 `failed_results[]`，HTTP 仍是 2xx。
> 封装层不应把 `failed_results` 当异常，而应正常返回让上层决定。

## 4. 错误响应（来自 `utils.ts handleRequestError`）

- HTTP 非 2xx 时，常规错误响应体形如：`{ "detail": { "error": "<message>" } }`。
  SDK 取 `res.data.detail.error` 作为异常 message。
- 无 `detail.error` 时，SDK 抛 `${status} Error: ${JSON.stringify(res.data)}`。
- keyless 限流信封（仅 keyless 模式，grapi 不涉及）：`{ "error": { "code", "message", "retry_after_seconds", "next_actions" } }`。
- SDK **不解析具体状态码**，只透传 message；常见码 `401`(无效 key) / `422`(参数错误) / `429`(限流) / `500`(服务端) —— **SDK reference 未明确列举，属实践推断**。
- 给 fetch 客户端的建议：非 2xx 时读 `body.detail?.error`，回退到 `${status} ${statusText}`。

## 5. 关于 `response_time` 类型

- SDK reference.md 表格标注为 `number`；extract 示例为 `1.23`（number）。
- 但 search 历史 JSON 示例出现过 `"1.67"`（string）。
- SDK 源码 `search.ts` / `extract.ts` 对 `response_time` **直接透传，不做类型转换**。
- 结论：**文档未明确统一**，实测可能 number 或 string。封装层应做 `Number()` 归一化（`src/web/tavily.ts` 的 `normalizeResponseTime` 即此职责）。

## 6. 给 fetch 封装的 KISS 清单

1. 只发 `POST /search`、`POST /extract`，header 只带 `Authorization: Bearer` + `Content-Type`。
2. 请求/响应一律 snake_case，不要在 fetch 层做 camelCase 转换（SDK 才做，我们不是 SDK）。
3. search 请求体只放 `query` + `max_results`；extract 只放 `urls` + `format: "markdown"`。
4. extract 的 `failed_results[]` 当数据返回，不当异常。
5. 非 2xx：读 `detail?.error`，回退 `status statusText`。
6. `response_time` 做 `Number()` 归一化。
7. base url 默认 `https://api.tavily.com`，构造函数留一个可覆盖参数即可（对齐 SDK 的 `apiBaseURL`）。
