## Agent 技能

### Issue tracker

Issues 跟踪在这个仓库的 GitHub Issues 中。详见 `docs/agents/issue-tracker.md`。

### Domain docs

单上下文仓库：在仓库根目录读取 `CONTEXT.md` 和 `docs/adr/`。详见 `docs/agents/domain.md`。

### E2E 测试

使用 pi CLI 直接加载本扩展进行端到端验证：

```bash
# 1. 设置 Tavily API key（可从 https://tavily.com 获取）
export TAVILY_API_KEY=<your-key>

# 2. 在仓库根目录启动 pi 并加载扩展
pi -e ./src/index.ts

# 3. 在 pi 中验证 web_search 已注册（例如询问）
#    "请列出当前可用的工具" 或 "用 web_search 搜索今日新闻"
```

若未设置 `TAVILY_API_KEY`，扩展仍会加载，但 `web_search` 不会注册，并在首次 `session_start` 时通过 `ctx.ui.notify` 提示一次。

非交互式验证示例（print 模式）：

```bash
pi -e ./src/index.ts -p "请列出当前所有可用工具" --provider zai-coding-cn --model glm-5.2
```

> 注意：print 模式下 `ctx.ui.notify` 不会触发，因此缺 key 通知不可见，但可通过工具列表确认 `web_search` 是否出现。
