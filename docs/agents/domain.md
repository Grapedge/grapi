# Domain Docs

本文件说明 engineering skills 在探索代码库时应如何消费本仓库的 domain 文档。

## 探索前先读这些

- 仓库根目录的 **`CONTEXT.md`**。
- **`docs/adr/`** —— 阅读与即将改动区域相关的 ADR。

若这些文件不存在，**静默继续**。不要提示缺失，也不要主动建议创建。`/domain-modeling` skill（通过 `/grill-with-docs` 与 `/improve-codebase-architecture` 触发）会在术语或决策真正被确定时按需创建它们。

## 目录结构

本仓库为单上下文仓库：

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

## 使用术语表的词汇

当输出中命名一个 domain 概念（如 issue 标题、重构提案、假设、测试名）时，应使用 `CONTEXT.md` 中定义的术语。不要漂移为术语表明确避免使用的同义词。

若所需概念尚未出现在术语表中，这是一个信号 —— 要么你发明了项目不使用的语言（请重新考虑），要么确实存在一个缺口（记下来，交给 `/domain-modeling` 处理）。

## 标记 ADR 冲突

若你的输出与现有 ADR 冲突，请显式指出，而不是静默覆盖：

> _与 ADR-0007（event-sourced orders）冲突 —— 但值得重新讨论，因为…_
