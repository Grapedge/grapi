# 测试规范

> 核心原则：**测试行为，不测试实现细节**。测试通过公共接口观察行为；内部实现可以整个重写，测试不应因此失败。

## 测试分层

| 层       | 对象                             | 手段                                           | 位置                       |
| -------- | -------------------------------- | ---------------------------------------------- | -------------------------- |
| L1 单元  | 纯函数、provider、工具 `execute` | mock 系统边界（fetch、fs）                     | `*.test.ts`（co-located）  |
| L2 集成  | 扩展 × AgentSession 交互         | pi 的 `AgentSession` + faux provider           | `tests/`（按需引入）       |
| L3 smoke | 真实 HTTP 契约 / 真实扩展加载    | `describe.skipIf(!process.env.SMOKE)`；`pi -e` | co-located 或 `tests/e2e/` |

当前以 L1 + L3 为主。L2 在需要验证扩展与 agent 全链路交互时引入。

## 框架与配置

- vitest，`globals: false`，显式 `import { describe, it, expect, vi } from "vitest"`。
- `environment: "node"`。
- coverage 阈值：`lines 80`、`statements 80`、`functions 80`、`branches 70`。
- 每个测试文件自包含，用 `beforeEach` / `afterEach` 管理状态。

## Seam 约定

**Seam = 测试观察行为的公共边界。** 测试只在 seam 上 mock。

- 只在系统边界 mock：外部 API（Tavily）、`fetch`、时间 / 随机数。
- **不 mock** 自己的类 / 模块 / 内部协作方。
- mock `fetch` 时只控制返回值，**不断言** `method` / `url` / `body`。
- HTTP 契约的真实正确性由 L3 smoke 覆盖。

## 测试写法

### AAA

每个测试分三段：Arrange、Act、Assert。

### 命名

采用三段式：被测对象 → 场景 → 期望。

```ts
describe("createWebSearchToolDefinition #unit", () => {
  describe("when the provider returns results", () => {
    it("then returns a markdown numbered list in content", async () => { ... });
  });
});
```

### Tags

- `#unit`：默认 L1 单测。
- `#smoke`：真实 API / E2E。
- `#integration`：进程内 AgentSession 集成测试。

运行子集：`npx vitest run --grep "#unit"`。

## Provider 测试模式

```ts
function givenTavilyResponds(body: unknown): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => body,
  } as Response);
}

it("maps a Tavily search response to WebSearchResponse", async () => {
  givenTavilyResponds({ query: "hi", results: [...], response_time: 1.67 });
  const provider = new TavilyProvider("test-key");
  const result = await provider.search({ query: "hi" });
  expect(result.responseTime).toBe(1.67);
});
```

- helper 名字用行为语言（`givenTavilyResponds`）。
- 期望值必须来自独立真值（手写 / 已知样例），不能用代码同样方式算出。

## 工具测试模式

```ts
const tool = createWebSearchToolDefinition(fakeProvider);
const result = await tool.execute("call-1", { query: "hi" });
expect(result.content[0].text).toContain("...");
```

- 直接实例化工具，不 mock pi。
- 断言 content / details 输出，不断言 provider 调用方式。

## 门控 smoke

smoke 不由 key 是否存在决定，而是由专门的 `SMOKE` 开关门控，避免 `npm run check` 误打真实三方 API：

```ts
describe.skipIf(!process.env.SMOKE)("live Tavily API #smoke", () => {
  it("searches the real endpoint", async () => {
    const provider = new TavilyProvider(process.env.TAVILY_API_KEY!);
    const result = await provider.search({ query: "hello", limit: 1 });
    expect(result.results.length).toBeGreaterThan(0);
  });
});
```

- `npm run check` / `npm run test` 默认不设 `SMOKE`，smoke 一律跳过；保持套件稳定且不依赖网络。
- 手动跑 smoke：`npm run test:smoke`（等价于 `SMOKE=1 vitest run -t #smoke`），需同时设置对应 key（`TAVILY_API_KEY` / `FAL_KEY`）。
- 这是防御实现细节错误躲过单测的最终防线。

## 反模式

- **Implementation-coupled**：mock 内部协作方、断言调用顺序 / 次数。
- **Tautological**：期望值用代码同样方式算出。
- **Horizontal slicing**：先写完所有测试再实现。应垂直切片：一个测试 → 一个最小实现 → 重复。

## TDD 循环

- 红先于绿：先写失败测试，再写刚好让它过的代码。
- 一次一片：一个 seam、一个测试、一个最小实现。
- 重构在测试绿后进行。
