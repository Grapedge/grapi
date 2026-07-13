# 代码规范

> 本仓库是 pi (`@earendil-works/pi-coding-agent`) 的扩展仓库。代码风格尽量与 pi 一致；因工具链不同而产生的差异会在各节标注 `【差异】` 并说明理由。
>
> 活范例：`src/web/tavily.ts`（本规范的参考实现）。

## 1. 总则

- **与 pi 对齐**：命名、TypeScript 风格、TypeBox schema、async/await、错误处理、named exports、工具/provider 设计模式。
- **既定差异**（工具链决定，保持，不强行对齐 pi）：
  - Lint/Format：**oxlint + oxfmt**（pi 用 Biome）
  - 缩进：**2 空格**（pi 用 tab / 宽度 3）
  - 相对 import 扩展名：**`.js`**（pi 源码写 `.ts`，靠 `rewriteRelativeImportExtensions`）
  - 测试位置：**co-located**（`foo.ts` 旁 `foo.test.ts`；pi 集中 `test/`）
  - vitest `globals`：**false**（显式 import；pi 用 true）

> 原则：差异只在「工具链强约束」或「既成事实」处保留。命名、类型、设计模式这类语言层面的约定，一律对齐 pi。

## 2. 工程配置

| 项       | 配置                                                                                                                                                                               |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 模块系统 | `"type": "module"`（ESM）                                                                                                                                                          |
| Node     | `>=22.0.0`                                                                                                                                                                         |
| TS       | `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `verbatimModuleSyntax` + `isolatedModules` + `moduleDetection: force`，`module: nodenext`，`target: esnext` |
| Lint     | `oxlint .`（`categories.correctness: error`）                                                                                                                                      |
| Format   | `oxfmt .`（默认配置 = 2 空格）                                                                                                                                                     |
| Test     | `vitest run`（`globals: false`，`environment: node`）                                                                                                                              |
| hooks    | husky `pre-commit` → `lint-staged` + `typecheck` + `test`                                                                                                                          |

提交前确保 `typecheck` / `lint` / `format:check` / `test` 全绿。

## 3. 命名约定

| 元素                             | 约定                              | 示例                                            |
| -------------------------------- | --------------------------------- | ----------------------------------------------- |
| 文件                             | kebab-case                        | `tavily.ts`、`web-search.ts`                    |
| 类型 / 接口                      | PascalCase                        | `WebSearchResponse`、`TavilyProvider`           |
| 函数 / 变量                      | camelCase                         | `loadConfig`、`registerWebSearchTool`           |
| 常量                             | UPPER_SNAKE_CASE                  | `DEFAULT_SEARCH_LIMIT`                          |
| **TypeBox schema 变量**          | **camelCase + `Schema` 后缀**     | `webSearchSchema`（不是 `WebSearchParameters`） |
| **派生类型**（`Static<typeof>`） | **PascalCase + `ToolInput` 后缀** | `WebSearchToolInput`                            |
| 工具 details 类型                | PascalCase + `ToolDetails` 后缀   | `WebSearchToolDetails`                          |
| 工厂函数                         | `create*` / `register*` 前缀      | `createWebSearchToolDefinition`                 |
| 布尔判断                         | `is*` / `has*` 前缀               | `isAvailable`                                   |

> **关键**：schema 是运行时**值**（TypeBox 对象），用 camelCase；`Static<typeof>` 派生出来的是**类型**，用 PascalCase。参考 pi 内置工具（`readSchema` / `ReadToolInput`），**不要**参考 pi 的 `examples/extensions/`（那里命名不严谨）。

## 4. 模块组织

- **测试 co-located**：`src/web/tavily.ts` ↔ `src/web/tavily.test.ts`。
- **集成 / E2E 测试**放 `tests/`（`vitest.config.ts` 已 include）。
- **named exports only**。唯一例外是扩展入口 `src/index.ts` 的 `export default function`（pi 加载契约要求 default export 工厂函数）。
- barrel export（`index.ts`）：按需引入；导出时区分 `export` 与 `export type`。

## 5. TypeScript 风格

- `interface` 用于对象形状；`type` 用于联合 / 别名 / 泛型推导。
- 类型 import 一律 `import type`；混合导入用 inline `type` 标记：`import { type Static, Type } from "typebox"`。
- 可选字段配合 `exactOptionalPropertyTypes`：写成 `field?: T | undefined`。
- 相对 import **必须带 `.js` 扩展名**（ESM nodenext 标准）：`from "./types.js"`。
- Node 内置用 `node:` 协议：`from "node:fs"`。
- `verbatimModuleSyntax` 下严格区分 value import 与 type import。
- 数字字面量用下划线分隔提高可读性：`2_147_483_647`。

## 6. 工具与 provider 设计

### 6.1 工具定义（对齐 pi 内置工具 `createReadToolDefinition`）

每个工具拆成「工厂」+「注册」两层：

```ts
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

const webSearchSchema = Type.Object({
  query: Type.String({ description: "Search query" }),
  limit: Type.Optional(Type.Number({/* ... */})),
});
export type WebSearchToolInput = Static<typeof webSearchSchema>;
export interface WebSearchToolDetails {
  /* 结构化 details 字段 */
}

export function createWebSearchToolDefinition(provider: WebSearchProvider) {
  return defineTool({
    name: "web_search",
    label: "Web Search",
    description: "...",
    parameters: webSearchSchema,
    async execute(_callId, { query, limit }: WebSearchToolInput) {
      // ...
      return { content: [{ type: "text", text }], details: {/* ... */} };
    },
  });
}

export function registerWebSearchTool(pi: ExtensionAPI, provider?: WebSearchProvider): void {
  if (!provider) return;
  pi.registerTool(createWebSearchToolDefinition(provider));
}
```

- **工厂返回独立、自包含的 ToolDefinition**——这样工具单元测试可以直接 `createWebSearchToolDefinition(fakeProvider)` 拿到对象测，**不需要 mock pi**。
- 注册函数变薄，只做「有 provider 才登记」。
- 用 `defineTool()` 而非裸对象，保留泛型推断。
- details 类型显式定义为 `XxxToolDetails`，不要用 `Partial<XxxResponse>` 内联。

### 6.2 Provider 抽象（provider 无关）

- 用 `interface` 定义 provider 无关契约（`WebSearchProvider` / `WebExtractProvider`），解耦工具层与具体 HTTP 后端（Tavily 今天，searxng/exa/firecrawl 明天）。
- provider 专有参数隔离在 provider 实现内，不污染工具 schema（见 `docs/HARNESS_DESIGN.md` #9）。

### 6.3 Provider 实现：class（充血模型）

provider 实现用 **class**，因为它持有状态（apiKey / baseUrl 等）：

```ts
export class TavilyProvider implements WebSearchProvider, WebExtractProvider {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://api.tavily.com",
  ) {}
  async search(input: WebSearchInput): Promise<WebSearchResponse> {
    /* ... */
  }
  async extract(input: WebExtractInput): Promise<WebExtractResponse> {
    /* ... */
  }
}
```

- class 的 `implements` 清晰表达契约；`private readonly` 硬约束封装。
- 工具定义用工厂函数（§6.1）；provider 实现用 class——两者各得其所。

### 6.4 外部 HTTP 调用

- 直接用原生 `fetch`，**不引入 axios / SDK 等重依赖**（`@tavily/core` 拖 axios + js-tiktoken + 181KB，不可接受）。
- HTTP 样板收敛进 provider 的一个私有方法（如 `post`）。
- wire 字段（请求/响应）保持 provider 后端的原始命名（如 Tavily 的 snake_case），映射到我们的 domain 类型在 provider 内部完成。

## 7. 错误处理

- 工具 `execute` 内 `throw new Error(...)`，由 agent runtime 捕获转为 tool result。
- 错误消息**面向模型 / 用户**，含可操作的下一步（`docs/HARNESS_DESIGN.md` #3）。例：401 时透出 provider 的 `detail.error`，让模型知道是认证问题。
- `extract` 这类「部分成功」语义：失败项进 `failed_results` 当**数据**返回，不抛异常。

## 8. 异步

- 一律 `async/await`，不用 `.then().catch()` 链。
- 错误通过 `throw` 传播，调用方 `try/catch` 或测试 `rejects.toThrow`。

## 9. 注释与文档

- public API 和复杂逻辑写 JSDoc（见 `src/web/types.ts`）。
- 注释解释 **why**，不解释 what。
- Biome/oxlint 忽略注释带原因：`// oxlint-ignore ...: <reason>`。

## 10. 依赖卫生

- 运行时依赖尽量为零（pi 通过 peerDependency 提供）。
- 引入新运行时依赖前评估体积与必要性；优先用原生能力（`fetch`、`node:*`）。
