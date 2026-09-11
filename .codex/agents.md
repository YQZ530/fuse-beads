本项目使用 PowerShell，生成命令时必须遵守：

- 将命令当作 PowerShell 代码处理，不直接套用 Bash 的转义方式。
- 搜索普通文本优先使用 rg -F；仅在确实需要时使用正则。
- 搜索词、正则和固定路径优先用单引号，避免变量展开。
- 不把 Markdown 的反引号作为命令内容传入。
- 包含单引号的 PowerShell 单引号字符串，用两个单引号表示。
- 文件操作使用 -LiteralPath；rg 使用明确的目录和 -g 文件过滤。
- 复杂脚本避免嵌套多层引号；必要时通过 apply_patch 创建脚本文件再执行。
- 执行前检查引号、反引号、$ 和通配符是否会被 shell 解释。
- 命令失败后先判断是否为 shell 解析问题，不直接归因于项目代码。

for example:
rg -n -F 'results/pic/' src scripts