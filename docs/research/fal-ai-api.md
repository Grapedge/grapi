# fal.ai 图像生成 API 调研

> 调研对象：[fal.ai](https://fal.ai) Model APIs，重点是文本到图像（text-to-image）生成能力。  
> 来源：官方文档（docs.fal.ai）、官方 JS SDK `@fal-ai/client` 源码、fal.ai Platform API/OpenAPI。  
> 用途：作为 [#3 设计/实现 `generate_image` 工具](https://github.com/Grapedge/grapi/issues/3) 的输入。

## TL;DR

- fal.ai 把每个模型暴露为一个独立的 HTTP endpoint，模型通过 URL 路径 `https://fal.run/<endpoint_id>` 指定，例如 `fal-ai/flux/dev`、`fal-ai/nano-banana-2`。
- 认证环境变量为 `FAL_KEY`，请求头格式为 `Authorization: Key <FAL_KEY>`。
- 调用方式有两种：同步 `run`（`https://fal.run/...`）和队列异步 `subscribe/submit`（`https://queue.fal.run/...`）。生产环境推荐 `subscribe`。
- 图像模型通用输入：`prompt`（必填）、`image_size`/`aspect_ratio`、`seed`、`num_images`、`negative_prompt`（部分模型）、`guidance_scale`、`enable_safety_checker`/`safety_tolerance`、`output_format`、`sync_mode`。
- 默认返回 CDN URL（`https://v3.fal.media/...`）；设置 `sync_mode: true` 则返回 base64 data URI，且不保存到请求历史。
- 计费按成功输出计费（图像通常按张或按 megapixel），队列等待与服务器错误不计费。并发限制默认 2，自助购买可提升至 40。
- 官方有 Node/TypeScript SDK `@fal-ai/client`，自动读取 `FAL_KEY`、内置重试、支持 proxy；REST 端点本身简单，grapi 可直接用 `fetch`。
- 设计建议：`ImageGenProvider` 应暴露 `model` 参数让用户选择，因为 fal.ai 不同模型在参数名（`image_size` vs `aspect_ratio`）、默认值、能力差异很大，不建议硬编码单一默认模型。

---

## 1. 认证与基础信息

| 项目          | 内容                                                                 |
| ------------- | -------------------------------------------------------------------- |
| 环境变量      | `FAL_KEY`（官方 SDK 默认读取）                                       |
| REST Base URL | 同步：`https://fal.run`；队列/异步：`https://queue.fal.run`          |
| 鉴权方式      | 请求头 `Authorization: Key <FAL_KEY>`                                |
| 平台 API Base | `https://api.fal.ai/v1`（用于查模型、价格等）                        |
| 官方 Node SDK | `@fal-ai/client`（也提供 `@fal-ai/server-proxy` 用于浏览器场景）     |
| Key Scope     | `API` 可调用所有 Model API；`ADMIN` 额外支持 CLI 部署、Serverless 等 |

> 官方文档明确：`FAL_KEY` 由 SDK/CLI 自动读取；REST 调用必须在 header 中传 `Authorization: Key $FAL_KEY`。[^auth-docs]  
> SDK 源码中 `credentialsFromEnv` 优先读取 `process.env.FAL_KEY`，header 拼接为 `Authorization: Key ${credentials}`。[^fal-js-config] [^fal-js-request]

[^auth-docs]: https://fal.ai/docs/documentation/setting-up/authentication

[^fal-js-config]: https://github.com/fal-ai/fal-js/blob/main/libs/client/src/config.ts

[^fal-js-request]: https://github.com/fal-ai/fal-js/blob/main/libs/client/src/request.ts

---

## 2. 提交生成请求：同步 vs 异步/队列

fal.ai 把每个模型作为独立 endpoint 暴露。同一个模型有两种调用入口：

| 模式       | REST URL                                  | HTTP 方法 | 说明                                                           | 适用场景            |
| ---------- | ----------------------------------------- | --------- | -------------------------------------------------------------- | ------------------- |
| 同步 `run` | `https://fal.run/<endpoint_id>`           | `POST`    | 直接返回结果，不经过队列；连接中断则请求丢失                   | 脚本、原型、低延迟  |
| 队列提交   | `https://queue.fal.run/<endpoint_id>`     | `POST`    | 立即返回 `request_id` 和状态/结果/取消 URL，稍后轮询或 webhook | 生产、并行、长任务  |
| 查状态     | `.../requests/{request_id}/status`        | `GET`     | 返回 `IN_QUEUE` / `IN_PROGRESS` / `COMPLETED`                  | 轮询                |
| 取结果     | `.../requests/{request_id}`               | `GET`     | 返回模型输出 JSON                                              | 状态为 COMPLETED 后 |
| 取消       | `.../requests/{request_id}/cancel`        | `PUT`     | 队列中立即移除；运行中发送取消信号                             | 超时/用户取消       |
| 流式状态   | `.../requests/{request_id}/status/stream` | GET SSE   | `text/event-stream`，持续推送状态至完成                        | 实时进度            |

> 同步 `run` 的 URL 由 SDK `buildUrl()` 生成：`https://fal.run/<appId>`；队列提交对应 `https://queue.fal.run/<appId>`。[^fal-js-request] [^fal-js-queue]  
> 官方文档：`subscribe` 底层走队列但自动轮询，是推荐的大多数用法；`submit` 给完整生命周期控制。[^sync-docs] [^queue-docs]

队列提交返回示例：

```json
{
  "request_id": "764cabcf-b745-4b3e-ae38-1200304cf45b",
  "response_url": "https://queue.fal.run/fal-ai/flux/schnell/requests/764cabcf.../response",
  "status_url": "https://queue.fal.run/fal-ai/flux/schnell/requests/764cabcf.../status",
  "cancel_url": "https://queue.fal.run/fal-ai/flux/schnell/requests/764cabcf.../cancel",
  "queue_position": 0
}
```

[^sync-docs]: https://fal.ai/docs/documentation/model-apis/inference/synchronous

[^queue-docs]: https://fal.ai/docs/documentation/model-apis/inference/queue

[^fal-js-queue]: https://github.com/fal-ai/fal-js/blob/main/libs/client/src/queue.ts

---

## 3. 支持的图像生成模型与模型指定方式

### 3.1 模型指定方式

模型通过 endpoint ID 作为 URL 路径段指定，例如：

```text
POST https://queue.fal.run/fal-ai/flux/dev
POST https://queue.fal.run/fal-ai/nano-banana-2
```

SDK 调用：

```ts
await fal.subscribe("fal-ai/flux/dev", { input: { prompt: "..." } });
```

> 查询可用模型：`GET https://api.fal.ai/v1/models?category=text-to-image&limit=100`；也可通过 `?endpoint_id=fal-ai/flux/dev&expand=openapi-3.0` 获取单个模型的完整输入输出 schema。[^platform-api-models]

[^platform-api-models]: https://docs.fal.ai/api-reference/platform-apis/for-models

### 3.2 常见图像生成模型（text-to-image）

以下是从 Platform API `category=text-to-image` 拉取的部分活跃模型（2026-07）：

| endpoint_id                         | 名称                   | 备注                                   |
| ----------------------------------- | ---------------------- | -------------------------------------- |
| `fal-ai/flux/dev`                   | FLUX.1 [dev]           | 12B 高质量，商业可用                   |
| `fal-ai/flux/schnell`               | FLUX.1 [schnell]       | 1-4 步快速生成                         |
| `fal-ai/flux-pro/v1.1`              | FLUX1.1 [pro]          | 增强细节与构图                         |
| `fal-ai/flux-2`                     | FLUX 2                 | BFL 新一代                             |
| `fal-ai/nano-banana-2`              | Nano Banana 2          | Google 快速图像生成/编辑               |
| `fal-ai/nano-banana-pro`            | Nano Banana Pro        | 写实与文字排版                         |
| `fal-ai/stable-diffusion-v3-medium` | Stable Diffusion V3    | 支持 negative prompt                   |
| `fal-ai/fast-sdxl`                  | Stable Diffusion XL    | 支持 LoRA、embeddings、negative prompt |
| `fal-ai/recraft/v4/text-to-image`   | Recraft V4             | 设计/营销视觉                          |
| `fal-ai/ideogram/v3`                | Ideogram Text to Image | 文字渲染                               |
| `openai/gpt-image-2`                | GPT Image 2 API        | OpenAI 模型，通过 fal 托管             |

> 不同模型参数差异很大：FLUX 系列用 `image_size`，Nano Banana 2 用 `aspect_ratio` + `resolution`，Stable Diffusion 系列支持 `negative_prompt` 和 `loras`。[^model-gallery] [^model-args]

[^model-gallery]: https://fal.ai/models

[^model-args]: https://fal.ai/docs/documentation/model-apis/model-arguments

---

## 4. 请求参数

### 4.1 通用/常见参数

| 参数                    | 类型                      | 必填 | 默认值       | 说明                                                                                            |
| ----------------------- | ------------------------- | ---- | ------------ | ----------------------------------------------------------------------------------------------- |
| `prompt`                | string                    | 是   | —            | 文本提示                                                                                        |
| `image_size`            | string / `{width,height}` | 否   | 因模型而异   | 预设：`square_hd`、`square`、`portrait_4_3`、`portrait_16_9`、`landscape_4_3`、`landscape_16_9` |
| `aspect_ratio`          | string                    | 否   | 因模型而异   | Nano Banana 2 等模型使用，如 `"16:9"`、`"1:1"`                                                  |
| `resolution`            | string                    | 否   | `"1K"`       | Nano Banana 2：`0.5K`、`1K`、`2K`、`4K`                                                         |
| `seed`                  | integer / null            | 否   | 随机         | 相同 seed + prompt 输出相同                                                                     |
| `num_images`            | integer                   | 否   | 1            | 通常 1-4（部分模型到 8）                                                                        |
| `negative_prompt`       | string                    | 否   | `""`         | SD/SDXL/SD3 等支持；FLUX/Nano Banana 通常不暴露                                                 |
| `guidance_scale`        | number                    | 否   | 因模型而异   | CFG，通常 1-20                                                                                  |
| `num_inference_steps`   | integer                   | 否   | 因模型而异   | 推理步数                                                                                        |
| `output_format`         | string                    | 否   | `jpeg`/`png` | `jpeg`、`png`、`webp`                                                                           |
| `enable_safety_checker` | boolean                   | 否   | true         | 启用后 NSFW 图片会被替换成黑图                                                                  |
| `safety_tolerance`      | string                    | 否   | 因模型而异   | `"1"` 最严格到 `"6"` 最宽松（Nano Banana 2 / FLUX Pro 等）                                      |
| `expand_prompt`         | boolean                   | 否   | false        | 自动扩写 prompt（部分模型名称为 `enable_prompt_expansion`）                                     |
| `sync_mode`             | boolean                   | 否   | false        | true 时媒体以 base64 data URI 返回，不进入请求历史                                              |
| `acceleration`          | string                    | 否   | `"none"`     | `none`/`regular`/`high`（FLUX 系列）                                                            |
| `system_prompt`         | string                    | 否   | `""`         | Nano Banana 2 等原生多轮模型的系统提示                                                          |
| `enable_web_search`     | boolean                   | 否   | false        | Nano Banana 2 允许联网检索参考                                                                  |

> 参数名和默认值高度模型相关。例如 `fal-ai/flux/dev` 默认 `image_size="landscape_4_3"`、`guidance_scale=3.5`；`fal-ai/stable-diffusion-v3-medium` 默认 `image_size="square_hd"`、`guidance_scale=5`；`fal-ai/nano-banana-2` 使用 `aspect_ratio="auto"`、`resolution="1K"`。[^flux-dev-openapi] [^sd3-openapi] [^nano2-openapi]

[^flux-dev-openapi]: https://api.fal.ai/v1/models?endpoint_id=fal-ai/flux/dev&expand=openapi-3.0

[^sd3-openapi]: https://api.fal.ai/v1/models?endpoint_id=fal-ai/stable-diffusion-v3-medium&expand=openapi-3.0

[^nano2-openapi]: https://api.fal.ai/v1/models?endpoint_id=fal-ai/nano-banana-2&expand=openapi-3.0

### 4.2 平台级 HTTP Header（与模型输入分离）

这些 header 控制基础设施行为，不是模型输入 JSON 的一部分：

| Header                                | 含义                                                            |
| ------------------------------------- | --------------------------------------------------------------- |
| `Authorization: Key <FAL_KEY>`        | 认证                                                            |
| `X-Fal-Request-Timeout: <seconds>`    | 服务器侧“开始处理”超时（含排队、路由、重试），非总耗时          |
| `X-Fal-Queue-Priority: normal/low`    | 队列优先级                                                      |
| `X-Fal-Object-Lifecycle-Preference`   | CDN 文件过期时间，JSON：`{"expiration_duration_seconds": 3600}` |
| `X-Fal-Store-IO: 0`                   | 不保存请求 payload（默认保存 30 天）                            |
| `X-Fal-No-Retry: 1`                   | 关闭自动重试                                                    |
| `X-Fal-Runner-Hint: <hint>`           | 路由提示，用于会话亲和                                          |
| `fal_max_queue_length`（query param） | 队列超过指定长度时直接返回 429                                  |

> 详见官方 Platform Headers 文档。[^headers-docs]

[^headers-docs]: https://fal.ai/docs/documentation/model-apis/common-parameters

---

## 5. 响应形状

### 5.1 默认模式：返回 CDN URL

```json
{
  "images": [
    {
      "url": "https://v3.fal.media/files/rabbit/abc123.png",
      "width": 1024,
      "height": 1024,
      "content_type": "image/png"
    }
  ],
  "prompt": "a sunset over mountains",
  "seed": 42,
  "timings": { "inference": 1.23 },
  "has_nsfw_concepts": [false]
}
```

字段说明：

| 字段                | 类型      | 说明                                                          |
| ------------------- | --------- | ------------------------------------------------------------- |
| `images`            | `Image[]` | 生成结果，每个元素含 `url`、`width`、`height`、`content_type` |
| `prompt`            | string    | 实际使用的 prompt                                             |
| `seed`              | integer   | 实际使用的 seed                                               |
| `timings`           | object    | 各阶段耗时                                                    |
| `has_nsfw_concepts` | boolean[] | 每张图是否被安全过滤器标记                                    |

> 官方文档示例与 FLUX OpenAPI schema 一致：输出 schema 要求 `images`、`timings`、`seed`、`has_nsfw_concepts`、`prompt`。[^queue-docs] [^flux-dev-openapi]

### 5.2 `sync_mode: true`：返回 base64 data URI

设置 `sync_mode: true` 后，`images[].url` 变为 base64 data URI，例如：

```text
data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQ...
```

> 官方说明：`sync_mode` 为 true 时媒体以 data URI 返回，且输出数据不会进入请求历史。[^flux-dev-openapi]  
> 注意：data URI 会显著增大响应体积，适合小图或一次性展示；长期保存应使用默认 CDN URL 并在过期前下载。

### 5.3 Webhook 推送格式

队列提交时若带 `?fal_webhook=https://...`，完成后 fal 会 POST：

```json
{
  "request_id": "abc123",
  "gateway_request_id": "abc123",
  "status": "OK",
  "payload": {
    "images": [{ "url": "https://fal.media/files/...", "width": 1024, "height": 1024 }],
    "seed": 196619188014358660
  }
}
```

> Webhook 15 秒超时，失败会在 2 小时内重试最多 10 次。[^webhook-docs]

[^webhook-docs]: https://fal.ai/docs/documentation/model-apis/inference/webhooks

---

## 6. 定价与速率/并发限制

### 6.1 定价

- fal.ai 采用预付费 credits 模式；仅对成功输出计费，服务器错误（HTTP 500+）和队列等待时间不计费。[^pricing-docs]
- 图像模型通常按 **每张图** 或 **每 megapixel** 计费；具体单价在模型页面和 `https://fal.ai/pricing` 查看。
- 可通过 Platform API 查询：`GET https://api.fal.ai/v1/models/pricing?endpoint_id=fal-ai/flux/dev`，需认证，返回 `unit_price` + `unit`（如 `"image"`）。

```json
{
  "prices": [
    { "endpoint_id": "fal-ai/flux/dev", "unit_price": 0.025, "unit": "image", "currency": "USD" }
  ]
}
```

[^pricing-docs]: https://fal.ai/docs/documentation/model-apis/pricing

### 6.2 并发与限流

| 项目         | 默认值/说明                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------ |
| 全局并发上限 | 新账号默认 2；根据近 4 周已付发票金额自动提升；自助上限 40                                                   |
| 队列         | 无大小限制；超并发时请求在队列等待，不会被丢弃                                                               |
| 重试         | SDK 对 `run` 的 429 自动指数退避重试；`subscribe`/`submit` 由服务端队列无限重试（除非 `start_timeout` 到期） |
| 429 响应     | `type: concurrent_requests_limit`，带 `X-Fal-needs-retry: 1` header                                          |
| 额外限制     | 部分高需求模型可能还有 per-endpoint 并发限制                                                                 |

> 详见 Concurrency Limits 文档。[^concurrency-docs]

[^concurrency-docs]: https://fal.ai/docs/documentation/model-apis/concurrency-limits

---

## 7. 对 `ImageGenProvider` 接口的设计建议

基于以上事实，建议 grapi 的 TypeScript provider 契约如下抽象：

```ts
interface ImageGenProvider {
  generate(input: ImageGenInput): Promise<ImageGenOutput>;
}

interface ImageGenInput {
  prompt: string;
  model: string; // endpoint_id，如 "fal-ai/flux/dev"
  n?: number; // 对应 num_images，默认 1
  size?: ImageSizePreset | { width: number; height: number };
  aspectRatio?: string; // 对 Nano Banana 2 等模型
  seed?: number;
  negativePrompt?: string; // 仅当底层模型支持时透传
  guidanceScale?: number;
  outputFormat?: "jpeg" | "png" | "webp";
  safety?: "off" | "low" | "normal" | "strict"; // 映射 enable_safety_checker / safety_tolerance
  syncMode?: boolean; // true 时返回 base64 data URI
  // 其他通用选项
  timeout?: number;
  webhookUrl?: string;
}

interface ImageGenOutput {
  images: Array<{
    url: string; // CDN URL 或 data URI
    width?: number;
    height?: number;
    contentType?: string;
    nsfw?: boolean;
  }>;
  seed?: number;
  prompt?: string;
  // 元信息
  usage?: { currency?: string; unitPrice?: number; estimatedCost?: number };
  timings?: Record<string, number>;
}
```

### 7.1 关于“默认模型 vs 暴露 model 参数”

**建议暴露 `model` 参数，而不是固定默认模型。** 理由：

1. 不同模型参数集不同：FLUX 用 `image_size`，Nano Banana 用 `aspect_ratio` + `resolution`，Stable Diffusion 支持 `negative_prompt` 和 LoRA。
2. 价格、速度、质量、安全策略差异大，用户/LLM 应根据场景选择。
3. 固定默认模型会在模型升级/下线时被迫改动；暴露 `model` 后 provider 只是透传 endpoint ID，更稳定。

若工具层希望提供“推荐模型”，可在 tool schema 里给 `model` 一个枚举默认值（如 `"fal-ai/flux/dev"`），但 provider 契约仍保留 `model` 字段。

### 7.2 实现方式建议

- 使用 `subscribe`（队列 + 自动轮询）作为主要调用路径：`POST https://queue.fal.run/<model>` → 轮询 `/status` → `GET /requests/{request_id}`。
- 透传请求头 `Authorization: Key <FAL_KEY>` 和 `Content-Type: application/json`。
- 不必须引入 `@fal-ai/client` 依赖；REST 端点简单且 `fetch` 足够。若未来需要类型生成或代理，再考虑 SDK。
- 对 `image_size` 与 `aspect_ratio` 的映射：provider 可先尝试模型 schema 中存在的字段，或让上层 tool 根据 `model` 选择正确的参数名。
- `safety` 可统一映射到：
  - `"off"` → `enable_safety_checker: false`（若模型支持）
  - `"low"/"normal"/"strict"` → `safety_tolerance: "6"/"4"/"1"`（若模型支持 `safety_tolerance`）

---

## 8. Node/TypeScript SDK `@fal-ai/client`

### 8.1 基本信息

- 包名：`@fal-ai/client`
- 安装：`npm install @fal-ai/client`
- 特点：TypeScript 类型安全、轻量（基于 `fetch`）、跨运行时（Node/Browser/React Native/Edge）。

### 8.2 核心方法

| 方法                   | 说明                         |
| ---------------------- | ---------------------------- |
| `fal.run(id, opts)`    | 同步直接调用，不经过队列     |
| `fal.subscribe(...)`   | 队列提交并自动轮询到完成     |
| `fal.queue.submit()`   | 仅提交，返回 `request_id`    |
| `fal.queue.status()`   | 查状态                       |
| `fal.queue.result()`   | 取结果                       |
| `fal.queue.cancel()`   | 取消请求                     |
| `fal.storage.upload()` | 上传文件到 fal CDN，返回 URL |

### 8.3 与直接 fetch 的对比

| 能力       | `@fal-ai/client`                      | 直接 `fetch`                |
| ---------- | ------------------------------------- | --------------------------- |
| 认证       | 自动读 `FAL_KEY`，也可 `fal.config()` | 手动拼 `Authorization: Key` |
| 重试       | 内置指数退避                          | 需自己实现                  |
| 队列轮询   | `subscribe` 自动完成                  | 需自己轮询 status/result    |
| 类型       | 基于 OpenAPI 生成输入输出类型         | 无类型或手写                |
| 依赖/体积  | 增加一个 npm 依赖                     | 零依赖                      |
| 浏览器安全 | 提供 `@fal-ai/server-proxy`           | 需自建代理                  |

**结论**：grapi 运行在 Node 服务端，直接 `fetch` 足够轻量；若希望减少轮询代码并获得类型，可引入 `@fal-ai/client`，但会增加依赖。

> SDK README 与源码：[fal-js](https://github.com/fal-ai/fal-js)。

---

## 9. 参考链接

- fal.ai Docs: https://docs.fal.ai
- Model APIs Overview: https://fal.ai/docs/documentation/model-apis/overview
- Authentication / Get Your API Key: https://fal.ai/docs/documentation/setting-up/authentication
- Synchronous Inference: https://fal.ai/docs/documentation/model-apis/inference/synchronous
- Asynchronous/Queue Inference: https://fal.ai/docs/documentation/model-apis/inference/queue
- Webhooks: https://fal.ai/docs/documentation/model-apis/inference/webhooks
- Platform Headers: https://fal.ai/docs/documentation/model-apis/common-parameters
- Common Model Arguments: https://fal.ai/docs/documentation/model-apis/model-arguments
- Pricing: https://fal.ai/docs/documentation/model-apis/pricing
- Concurrency Limits: https://fal.ai/docs/documentation/model-apis/concurrency-limits
- fal CDN / Data Retention: https://fal.ai/docs/documentation/model-apis/fal-cdn / https://fal.ai/docs/documentation/model-apis/media-expiration
- Model Gallery: https://fal.ai/models
- Pricing Page: https://fal.ai/pricing
- Platform API (models/pricing): https://docs.fal.ai/api-reference/platform-apis/for-models
- `@fal-ai/client` GitHub: https://github.com/fal-ai/fal-js
- `@fal-ai/client` npm: https://www.npmjs.com/package/@fal-ai/client
