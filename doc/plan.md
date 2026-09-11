# 开发计划

更新日期：2026-09-11

## 已完成

- [x] 豆仓统一为英文命名的 inventory.csv 和 transactions.csv，迁移原元数据和流水；网页、项目及库存脚本共用 CSV。
- [x] 按确认数量导入亚麻与221色库存，并记录迁移调整及期初流水。
- [x] 覆盖 CSV 往返、多行备注、并发写入、写入恢复、221色创建、补货及回滚测试。

- [x] 工具按 `scripts/javascript/`、`scripts/python/`、`scripts/tests/` 分类。
- [x] 功能文档与开发日志统一到 `doc/`。
- [x] 修复网格检测 API 的 Python 脚本路径。
- [x] app 数据按 `1.source-images/`、`2.grid-detection/`、`3.parsed-grid/` 分阶段。
- [x] 项目和库存迁入 `results/app/projects/`、`results/app/warehouse/`。
- [x] processing 使用 `1.grouped-images/` 与 `2.groupped-bead-count/`。
- [x] 分组 manifest 合入截图目录，核对内容后删除与主清单完全相同的 archived 副本。
- [x] 同步应用、脚本与保存数据的路径引用。
- [x] 开发日志记录网页 v2 临时检测与已有 v3 产物的实际关系。
- [x] TypeScript、5 项豆仓测试、Python 语法检查通过；迁移后的 v2 脚本使用现有原图成功生成 geometry JSON 和 SVG。
- [x] 用户确认四张新增图纸的用豆统计，完成 manifest、main、debug 合并并删除三个 `.new` 文件。

## 后续

- [ ] 将网页检测结果持久化到 Stage 2，并建立与原图、Stage 3 的关联。

阶段定义和当前运行方式见 `development-log.md`，已实现功能见 `feature-docs.md`。
