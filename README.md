# grapi

grapi 是我个人的 [pi](https://pi.dev) 扩展。

## 安装

```bash
pi install npm:grapi
```

## 配置

联网功能依赖 [Tavily](https://tavily.com) 的 API，需要设置环境变量：

```bash
export TAVILY_API_KEY="your-api-key"
```

## 工具

### web_search

联网搜索，返回标题、链接和摘要。

参数：

- query：搜索词
- limit：返回结果数量，1–10，默认 5

### web_extract

读取单个网页的正文内容，返回 Markdown。

参数：

- url：网页地址

## Todo

- [ ] generate_image
- [ ] subagent
- [ ] /goal
- [ ] ...
