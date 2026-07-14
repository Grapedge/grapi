# grapi

grapi 是我个人的 [pi](https://pi.dev) 扩展。

## 安装

```bash
pi install npm:@grapedge/grapi
```

## 配置

联网功能依赖 [Tavily](https://tavily.com) 的 API，图像生成依赖 [fal.ai](https://fal.ai) 的 API，需要设置环境变量：

```bash
export TAVILY_API_KEY="your-api-key"
export FAL_KEY="your-fal-key"
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

### image_generate

根据文本提示生成图片，或基于参考图片进行编辑。

参数：

- prompt：图片描述
- aspect_ratio：输出比例预设，可选值：
  `square`、`square_hd`、`landscape_4_3`、`landscape_16_9`、`portrait_4_3`、`portrait_16_9`；默认 `landscape_4_3`
- reference_image_paths：参考图片的本地路径列表（用于图生图编辑）

## Todo

- [x] image_generate
- [ ] subagent
- [ ] /goal
- [ ] ...
