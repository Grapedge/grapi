# Issue tracker: GitHub

本仓库的 issues 与 PRD 以 GitHub issues 形式存在。所有操作均使用 `gh` CLI。

## 约定

- **创建 issue**：`gh issue create --title "..." --body "..."`。多行正文使用 heredoc。
- **读取 issue**：`gh issue view <number> --comments`，并通过 `jq` 过滤评论与标签。
- **列出 issues**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，按需附加 `--label` 与 `--state` 过滤条件。
- **评论 issue**：`gh issue comment <number> --body "..."`
- **添加 / 移除标签**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **关闭 issue**：`gh issue close <number> --comment "..."`

仓库从 `git remote -v` 自动推断 —— 在克隆目录中运行 `gh` 时会自动识别。

## 当 skill 要求 "publish to the issue tracker"

创建一个 GitHub issue。

## 当 skill 要求 "fetch the relevant ticket"

运行 `gh issue view <number> --comments`。

## Wayfinding 操作

`/wayfinder` 使用以下约定：**map** 是一个 issue，**child** issue 作为任务 ticket。

- **Map**：单个 issue，标签为 `wayfinder:map`，正文包含 Notes / Decisions-so-far / Fog。创建命令：`gh issue create --label wayfinder:map`。
- **Child ticket**：通过 GitHub sub-issue 关联到 map 的 issue（使用 `gh api` 的 sub-issues 端点）。若 sub-issues 未启用，则在 map 正文中以任务列表形式添加子任务，并在 child 正文顶部写入 `Part of #<map>`。标签为 `wayfinder:<type>`（`research`/`prototype`/`grilling`/`task`）。认领后，将 ticket 分配给当前开发者。
- **阻塞关系**：优先使用 GitHub 原生的 **issue dependencies** —— 这是 UI 可见的标准方式。添加阻塞边：`gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`，其中 `<blocker-db-id>` 是阻塞者的数字型 **database id**（通过 `gh api repos/<owner>/<repo>/issues/<n> --jq .id` 获取，_不是_ `#number` 或 `node_id`）。GitHub 通过 `issue_dependencies_summary.blocked_by` 返回当前仍打开的阻塞者。若 dependencies 不可用，则在 child 正文顶部回退写入 `Blocked by: #<n>, #<n>`。当所有阻塞者关闭时，ticket 视为解除阻塞。
- **Frontier query**：列出 map 下仍打开的 children（通过 map 的 sub-issues / 任务列表限定范围），剔除仍有打开阻塞者（`issue_dependencies_summary.blocked_by > 0`，或 `Blocked by` 行中有打开 issue）或已有 assignee 的项；按 map 顺序取第一个。
- **Claim**：`gh issue edit <n> --add-assignee @me` —— 本次会话的首次写入。
- **Resolve**：先 `gh issue comment <n> --body "<answer>"`，然后 `gh issue close <n>`，最后将上下文指针（gist + 链接）追加到 map 的 Decisions-so-far 中。
