# 测试规范

> 核心原则（来自 `/tdd` skill）：**测试行为，不测试实现细节**。测试通过公共接口观察行为，像规格说明书；代码内部可以整个重写，测试不该因此失败。
>
> 活范例：`src/web/tavily.test.ts`（行为测试 + 门控 smoke 的参考实现）。

## 1. 测试分层

| 层                        | 对象                             | 手段                                                                     | 位置                       |
| ------------------------- | -------------------------------- | ------------------------------------------------------------------------ | -------------------------- |
| **L1 单元**（主力）       | 纯函数、provider、工具 `execute` | mock 系统边界的返回值                                                    | co-located `*.test.ts`     |
| **L2 进程内集成**（可选） | 扩展 × AgentSession 交互         | `@earendil-works/pi-ai` 的 `registerFauxProvider` + `createAgentSession` | `tests/`                   |
| **L3 门控 smoke / E2E**   | 真实 HTTP 契约 / 真实扩展加载    | `describe.skipIf(!env.KEY)` 真实调用；`pi -e` 真实加载                   | co-located 或 `tests/e2e/` |

> 当前以 **L1 + L3** 为主。L2 在「需要验证扩展与 agent 全链路交互」时引入（加 `@earendil-works/pi-ai` 为 devDependency）。

## 2. 框架与配置

- **vitest**，`globals: false` → 显式 `import { describe, it, expect, vi } from "vitest"`。
- `environment: "node"`。
- `include: ["src/**/*.test.ts", "tests/**/*.test.ts"]`。
- 无 `setupFiles` / `globalSetup`——每个测试文件自包含，用 `beforeEach` / `afterEach` 显式管理状态。

## 3. Seam 约定（最关键）

**Seam = 测试观察行为的公共边界。** 测试只在 seam 上进行。

- **mock 只在系统边界**：外部 API（Tavily）、`fetch`、时间 / 随机数。**不 mock** 自己的类 / 模块 / 内部协作方。
- **mock `fetch` 时只控制它的返回值，绝不 `expect(fetch).toHaveBeenCalledWith(method/url/body)`**——后者是断言实现细节，是 `/tdd` 明确点名的反模式。
  - 反例（旧 `tavily.test.ts` 就是这么写的，已删）：断言 `method: "POST", body: JSON.stringify({...})` 看似在验证契约，实则既耦合实现、又抓不住真实错误（mock 无论 GET/POST 都返回预设数据，单测照绿）。
  - 正例：`givenTavilyResponds(body)` 只设置 fetch 返回，断言 provider 的**输出映射**是否正确。
- **HTTP 契约（method/auth/wire）的真实正确性由 L3 门控 smoke 覆盖**，不在 L1 单测里断言。

## 4. 门控 smoke（`skipIf` 模式）

真实 API 调用用环境变量门控，CI 无 key 自动跳过，本地有 key 才跑：

```ts
describe.skipIf(!process.env.TAVILY_API_KEY)("live Tavily API (requires TAVILY_API_KEY)", () => {
  it("searches the real Tavily /search endpoint end-to-end", async () => {
    const provider = new TavilyProvider(process.env.TAVILY_API_KEY!);
    const result = await provider.search({ query: "hello world", limit: 1 });
    expect(result.results.length).toBeGreaterThan(0);
  });
});
```

- 这是防御「实现细节错误躲过单测」的最终防线（如用错 HTTP method、认证写错端点）。
- 真实调用会消耗 provider 配额，故只在有 key 时跑。
- pi 的 `ai` 包也是这套（`describe.skipIf(!process.env.XXX_API_KEY)`）。

## 5. 工具测试模式（目标形态）

工具按 §6.1（代码规范）抽 `createXxxToolDefinition` 后，测试**不需要 mock pi**——直接造工具对象：

```ts
const tool = createWebSearchToolDefinition(fakeProvider);
const result = await tool.execute("call-1", { query: "hi" });
expect(result.content[0].text).toContain("...");
```

- 不要像旧 `search.test.ts` 那样 mock `pi.registerTool` 再从 `mock.calls` 里「偷」出 ToolDefinition——那是工具定义被锁在注册函数里时的妥协。工厂模式让工具可独立实例化。

## 6. Provider 测试模式（`tavily.test.ts` 范例）

```ts
function givenTavilyResponds(body: unknown, init?: { ok?; status?; statusText? }): void {
  globalThis.fetch = vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => body /* ... */ } as Response);
}

it("maps a Tavily search response to WebSearchResponse", async () => {
  givenTavilyResponds({ query: "hi", results: [/* 真实的 wire 结构 */], response_time: 1.67 });
  const provider = new TavilyProvider("test-key");
  const result = await provider.search({ query: "hi" });
  expect(result.responseTime).toBe(1.67); // 期望值是独立手写字面量，不是用代码方式算出的
});
```

- `given*Responds` helper 封装 mock 设置，名字用行为语言（「给定 provider 返回 X」），不暴露 fetch 细节。
- **expected value 必须来自独立真值**（手写字面量 / 已知样例 / 契约），不能像代码那样算出（否则是 tautological 测试）。

## 7. 命名与组织

- 文件：kebab-case + `.test.ts`，co-located。
- `describe` / `it` 组织；`it` 名描述 **WHAT**（「maps a search response」）不描述 HOW（「calls fetch with POST」）。
- **回归测试**：`tests/regressions/<issue-number>-<short-slug>.test.ts`（采纳 pi 约定），文件头注释带 issue 链接与故障根因。

## 8. 反模式（`/tdd` 明令禁止）

- **Implementation-coupled**：mock 内部协作方、测私有方法、断言调用次数 / 顺序、通过旁路（查数据库）验证。特征：重构但行为没变时测试却挂了。
- **Tautological**：期望值用代码同样的方式算出（`expect(add(a,b)).toBe(a+b)`），永远不可能和代码不一致。期望必须来自独立真值。
- **Horizontal slicing**：先写完所有测试再实现。应做 vertical slice：一个测试 → 一个最小实现 → 重复。

## 9. TDD 循环（`/tdd`）

- **红先于绿**：先写失败测试，再写刚好让它过的代码；不预判未来测试、不加投机功能。
- **一次一片**：一个 seam、一个测试、一个最小实现。
- **重构不属于循环**：重构归 code-review 阶段，不在红→绿循环内。

## 10. E2E（真实扩展加载）

验证「扩展被真实 pi 加载、工具链路通」用 `pi -e`（见 `AGENTS.md`）：

```bash
pi -e ./src/index.ts -p "请列出当前所有可用工具"
```

自动化时可用 `child_process.spawn` 起 pi 子进程做 smoke（pi 自己的 CLI 集成测试同款手法）。
