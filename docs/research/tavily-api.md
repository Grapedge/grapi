# Tavily Search / Extract API 调研

> 调研对象：[Tavily](https://tavily.com) 的 Search 与 Extract API。  
> 来源：官方文档（docs.tavily.com）、官方 JS SDK `@tavily/core`（即 `tavily-js`）自动生成的 API 参考。  
> 用途：作为 [#4 设计 web 域能力接口契约](https://github.com/Grapedge/grapi/issues/4) 的输入。

## TL;DR

- Tavily 提供两个对 grapi 直接有用的能力：**Search**（联网搜索）与 **Extract**（网页内容提取）。
- 认证统一用 `TAVILY_API_KEY`，REST base URL 为 `https://api.tavily.com`。
- 官方有 Node SDK `@tavily/core`，但 REST 端点简单，grapi 可直接用 `fetch` 调用以避免额外依赖。
- Search 返回 `results[]`（含 `title/url/content/score/published_date/favicon`）与可选的 `answer`；Extract 返回 `results[]` / `failed_results[]`，单请求最多 20 个 URL。
- 建议 grapi 的 `WebSearchProvider` / `WebExtractProvider` 以「纯能力契约」抽象这些字段，不暴露 Tavily 专有形如 `search_depth`、`chunks_per_source` 的参数名，而是映射到更通用的概念（如 `detail`、`max_results`、`time_range`）。

---

## 1. 认证与基础信息

| 项目          | 内容                                                                         |
| ------------- | ---------------------------------------------------------------------------- |
| 环境变量      | `TAVILY_API_KEY`（官方 SDK 默认读取）                                        |
| REST Base URL | `https://api.tavily.com`                                                     |
| 鉴权方式      | 请求头 `Authorization: Bearer <TAVILY_API_KEY>`，或在 body 里传 `api_key`    |
| 官方 Node SDK | `@tavily/core`（原 `tavily-js`）                                             |
| 无 Key 模式   | SDK 支持 keyless（共享速率限制），但 grapi 走环境变量，探测到 key 才注册工具 |

> 注：grapi 的 config 约定与官方一致即可：默认读 `process.env.TAVILY_API_KEY`。

---

## 2. Search API

### 2.1 REST 端点

```http
POST https://api.tavily.com/search
Authorization: Bearer <TAVILY_API_KEY>
Content-Type: application/json
```

### 2.2 请求参数

| 参数                         | 类型          | 必填 | 默认值    | 说明                                                              |
| ---------------------------- | ------------- | ---- | --------- | ----------------------------------------------------------------- |
| `query`                      | string        | 是   | —         | 搜索查询                                                          |
| `search_depth`               | string        | 否   | `basic`   | `basic` / `advanced` / `fast` / `ultra-fast`；latency vs 质量权衡 |
| `max_results`                | integer       | 否   | `5`       | 返回结果数量上限                                                  |
| `topic`                      | string        | 否   | `general` | `general` / `news` / `finance`                                    |
| `time_range`                 | string        | 否   | `null`    | `day` / `week` / `month` / `year`（或 `d/w/m/y`）                 |
| `start_date` / `end_date`    | string        | 否   | —         | 日期过滤                                                          |
| `include_answer`             | bool / string | 否   | `false`   | `true` / `basic` / `advanced`；让 Tavily 用 LLM 生成答案          |
| `include_raw_content`        | bool / string | 否   | `false`   | 是否返回原始网页内容；`markdown` / `text`                         |
| `include_images`             | bool          | 否   | `false`   | 返回结果相关图片                                                  |
| `include_image_descriptions` | bool          | 否   | `false`   | 为图片生成描述                                                    |
| `include_favicon`            | bool          | 否   | `false`   | 返回站点 favicon                                                  |
| `include_usage`              | bool          | 否   | `false`   | 返回 credit 消耗                                                  |
| `include_domains`            | string[]      | 否   | `[]`      | 限定域名                                                          |
| `exclude_domains`            | string[]      | 否   | `[]`      | 排除域名                                                          |
| `chunks_per_source`          | integer       | 否   | `3`       | 仅 `search_depth=advanced` 时有效，每源返回 chunk 数（1–5）       |
| `country`                    | string        | 否   | —         | 地区代码                                                          |
| `auto_parameters`            | bool          | 否   | —         | 是否让 Tavily 自动优化参数                                        |

### 2.3 响应字段

```json
{
  "query": "Who is Leo Messi?",
  "answer": "Lionel Messi, born in 1987, is an Argentine footballer...",
  "images": [{ "url": "...", "description": "..." }],
  "results": [
    {
      "title": "Lionel Messi - Wikipedia",
      "url": "https://en.wikipedia.org/wiki/Lionel_Messi",
      "content": "Lionel Andrés Messi (born 24 June 1987)...",
      "raw_content": null,
      "score": 0.95,
      "published_date": "2023-10-26",
      "favicon": "https://en.wikipedia.org/favicon.ico",
      "images": []
    }
  ],
  "response_time": "1.67",
  "auto_parameters": { "topic": "general", "search_depth": "basic" },
  "usage": { "credits": 1 },
  "request_id": "..."
}
```

| 字段                       | 类型            | 说明                                     |
| -------------------------- | --------------- | ---------------------------------------- |
| `query`                    | string          | 实际执行的查询                           |
| `answer`                   | string?         | LLM 生成的答案（需 `include_answer`）    |
| `results`                  | array           | 搜索结果列表                             |
| `results[].title`          | string          | 标题                                     |
| `results[].url`            | string          | 链接                                     |
| `results[].content`        | string          | 摘要/片段                                |
| `results[].raw_content`    | string?         | 原始网页内容（需 `include_raw_content`） |
| `results[].score`          | number          | 相关度分数                               |
| `results[].published_date` | string?         | 发布日期                                 |
| `results[].favicon`        | string?         | 站点 favicon（需 `include_favicon`）     |
| `results[].images`         | array?          | 图片列表（需 `include_images`）          |
| `images`                   | array           | 全局图片列表                             |
| `response_time`            | string / number | 响应耗时                                 |
| `usage.credits`            | integer         | 消耗 credits                             |
| `request_id`               | string          | 请求追踪 ID                              |

---

## 3. Extract API

### 3.1 REST 端点

```http
POST https://api.tavily.com/extract
Authorization: Bearer <TAVILY_API_KEY>
Content-Type: application/json
```

### 3.2 请求参数

| 参数                | 类型               | 必填 | 默认值                       | 说明                                |
| ------------------- | ------------------ | ---- | ---------------------------- | ----------------------------------- |
| `urls`              | string \| string[] | 是   | —                            | 要提取的 URL；数组最多 20 个        |
| `extract_depth`     | string             | 否   | `basic`                      | `basic` / `advanced`；advanced 更贵 |
| `format`            | string             | 否   | `markdown`                   | `markdown` / `text`                 |
| `include_images`    | bool               | 否   | `false`                      | 返回页面图片 URL 列表               |
| `include_favicon`   | bool               | 否   | `false`                      | 返回 favicon URL                    |
| `include_usage`     | bool               | 否   | `false`                      | 返回 credit 消耗                    |
| `query`             | string             | 否   | —                            | 用户意图，用于对提取内容做 rerank   |
| `chunks_per_source` | integer            | 否   | `3`                          | 每源返回 chunk 数（1–5）            |
| `timeout`           | number             | 否   | 10s (basic) / 30s (advanced) | 超时秒数（1.0–60.0）                |

### 3.3 响应字段

```json
{
  "results": [
    {
      "url": "https://en.wikipedia.org/wiki/Artificial_intelligence",
      "raw_content": "Artificial intelligence (AI) is the intelligence of machines...",
      "images": ["https://..."],
      "favicon": "https://en.wikipedia.org/favicon.ico"
    }
  ],
  "failed_results": [{ "url": "https://bad.example", "error": "Could not fetch page" }],
  "response_time": 1.23,
  "usage": { "total_credits_used": 1 }
}
```

| 字段                       | 类型      | 说明                                 |
| -------------------------- | --------- | ------------------------------------ |
| `results`                  | array     | 成功提取的结果                       |
| `results[].url`            | string    | 网页 URL                             |
| `results[].raw_content`    | string    | 提取的正文内容                       |
| `results[].images`         | string[]? | 图片 URL 列表（需 `include_images`） |
| `results[].favicon`        | string?   | favicon URL（需 `include_favicon`）  |
| `failed_results`           | array     | 失败的 URL                           |
| `failed_results[].url`     | string    | 失败的 URL                           |
| `failed_results[].error`   | string    | 错误信息                             |
| `response_time`            | number    | 响应耗时                             |
| `usage.total_credits_used` | integer   | 消耗 credits                         |

> 注意：官方 REST 文档页面与 `llms-full.txt` 对单个 URL 的返回格式描述不完全一致；实际批量调用时返回的是 `results[]` + `failed_results[]`。grapi 的 `WebExtractProvider` 应统一按批量/失败分离的形式设计。

---

## 4. 对 #4「web 域接口契约」的设计输入

1. **能力切分**：Tavily 同时实现了 search 与 extract，一个 `TavilyProvider` 可实现两个能力接口 `WebSearchProvider` + `WebExtractProvider`。
2. **Search 契约建议**：
   - 输入：`query`（必需）、`max_results`、`time_range`、`detail`（映射 `search_depth`）、`include_answer` 等。
   - 输出：标准化的 `results[]`（至少含 `title`、`url`、`content`、`score`、`publishedAt`）、可选的 `answer`、以及元信息（`usage`、`responseTime`）。
   - 不要把 Tavily 的 `include_raw_content`、`chunks_per_source` 等直接暴露给 tool schema，除非 tool 明确需要。
3. **Extract 契约建议**：
   - 输入：`urls`（数组，但 tool 层可接受单个 string 并自动包装）、`detail`、`format`。
   - 输出：`results[]`（`url`、`content`、`images`、`favicon`）+ `failed[]`（`url`、`error`）。
   - 必须显式处理部分失败的情况，而不是抛异常。
4. **环境变量**：统一使用 `TAVILY_API_KEY`，与官方约定一致，config 中无需额外转换。
5. **直接 REST vs SDK**：建议 grapi 直接用 `fetch` 调用 REST，避免引入 `@tavily/core` 依赖；端点与参数都很稳定，且能减少打包体积。

---

## 5. 参考链接

- Tavily Docs: https://docs.tavily.com
- Search REST: https://docs.tavily.com/documentation/api-reference/endpoint/search
- Extract REST: https://docs.tavily.com/documentation/api-reference/endpoint/extract
- JS SDK: https://github.com/tavily-ai/tavily-js / npm `@tavily/core`
