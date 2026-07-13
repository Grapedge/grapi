# AGENTS.md

grapi 是我的个人 pi extensions。

## 文档

- 当需要设计 extension 时，阅读 `docs/HARNESS_DESIGN.md`。
- 当需要编写代码时，阅读 `docs/CODING_STANDARDS.md`。
- 当需要编写测试时，阅读 `docs/TESTING_STANDARDS.md`。

## 验证

1. 开发完成后，执行 `npm run check` 检查错误。
2. （可选）在真实环境中验证扩展效果：

```bash
pi -e <entry-file> \
  --no-session \
  -p "你的提示词"
```
