# 代码规范

## 总则

- 代码应简单、直接、可测试。优先遵循 KISS 与 YAGNI。
- 工具链约束由配置强制，不在文档中重复：
  - `tsconfig.json` 已开启 `strict`、`erasableSyntaxOnly`、`noUnusedLocals` 等。
  - `oxlint` 与 `oxfmt` 负责 lint 与 format。
- 任何代码变更后必须 `npm run check` 全绿。

## 工程配置

| 项            | 配置                                                                         |
| ------------- | ---------------------------------------------------------------------------- |
| 模块          | ESM (`"type": "module"`)                                                     |
| Node          | `>=22.0.0`                                                                   |
| TS            | `strict` + `erasableSyntaxOnly` + `verbatimModuleSyntax` + `isolatedModules` |
| Lint / Format | `oxlint .` / `oxfmt .`                                                       |
| Test          | `vitest run`（`globals: false`，显式 import）                                |
| 标准检查      | `npm run check`                                                              |

## 命名约定

| 元素           | 约定                     | 示例                            |
| -------------- | ------------------------ | ------------------------------- |
| 文件           | kebab-case               | `web-search.ts`                 |
| 类型 / 接口    | PascalCase               | `WebSearchResponse`             |
| 函数 / 变量    | camelCase                | `loadConfig`                    |
| 常量           | UPPER_SNAKE_CASE         | `DEFAULT_SEARCH_LIMIT`          |
| TypeBox schema | camelCase + `Schema`     | `webSearchSchema`               |
| 派生类型       | PascalCase + `ToolInput` | `WebSearchToolInput`            |
| 工厂函数       | `create*` / `register*`  | `createWebSearchToolDefinition` |
| 布尔判断       | `is*` / `has*`           | `isAvailable`                   |

## 模块组织

- 测试与实现同目录：`foo.ts` + `foo.test.ts`。
- 只使用 named exports；扩展入口的 `export default function` 是 pi 加载契约要求的唯一例外。
- 相对 import 带 `.js` 扩展名；Node 内置用 `node:` 协议。
- 类型导入用 `import type` 或 inline `type`。

## 工具与 Provider 设计

### 工具定义

每个工具拆成「工厂」+「注册」两层：

```ts
export function createWebSearchToolDefinition(provider: WebSearchProvider) {
  return defineTool({
    name: "web_search",
    parameters: webSearchSchema,
    async execute(_callId, input) {
      // ...
    },
  });
}

export function registerWebSearchTool(pi: ExtensionAPI, provider?: WebSearchProvider): void {
  if (!provider) return;
  pi.registerTool(createWebSearchToolDefinition(provider));
}
```

- 工厂返回独立、自包含的 `ToolDefinition`，单元测试可直接实例化，无需 mock pi。
- 注册函数只负责「有条件地登记」。

### Provider 抽象

- 用 `interface` 定义 provider 无关契约（如 `WebSearchProvider`），解耦工具与 HTTP 后端。
- provider 专有参数隔离在 provider 实现内，不污染工具 schema。
- provider 实现用 class，显式字段 + 构造函数赋值（满足 `erasableSyntaxOnly`）。

### HTTP 调用

- 用原生 `fetch`，不引入 axios / SDK 等重依赖。
- wire 字段保持 provider 后端的原始命名，映射到 domain 类型在 provider 内部完成。

## 错误处理

- 工具 `execute` 内 `throw new Error(...)`，由 pi runtime 捕获。
- 错误消息面向模型 / 用户，包含可操作的下一步。
- 部分成功语义（如 extract 的 `failed_results`）作为数据返回，不抛异常。

## 异步

- 一律 `async/await`。
- 错误通过 `throw` 传播。

## 依赖卫生

- 运行时依赖尽量为零（pi 与 typebox 通过 peerDependencies 提供）。
- 新增依赖前评估体积与必要性；优先用原生能力。
