# 开发日志

## 2026-09-11：修复预期值校验

`build_final_payload` 原先在 expectedPairKey 缺失时回退到 groupCount。groupCount 是分组内截图张数，Image13、Image21 各一张，导致 expected="1" 并误报冲突。现改为只接受完整的“色数_豆数”；缺失或格式无效时 expected 为空、matchesExpected 为 null。

更新日期：2026-09-11

## 代码结构

```text
src/                         网站和 API 代码
  app/                       Next.js 页面及 API 路由
    analysis/                图纸裁剪、解析和校正
    warehouse/               豆仓管理
    projects/                项目列表和详情
    api/                     图纸、项目、豆仓、色板接口
  components/                React UI 组件
  hooks/                     React 状态与交互逻辑
  lib/                       数据存储等服务逻辑
  utils/                     图像、网格、颜色及导出算法
  data/                      色板等静态数据
  types/                     共享 TypeScript 类型
  pics/                      应用图片资源
scripts/
  javascript/                手动运行的 JS 工具
  python/                    Python 工具
    test_scr/                库存计算和配色实验工具
  tests/                     自动化测试
doc/
  feature-docs.md             已实现功能与变更记录
  development-log.md          脚本目标、开发与验证记录
```

豆仓存储入口：`src/lib/warehouseStore.ts`；项目服务：`src/app/api/projects/_projectStore.ts`；图纸解析算法：`src/utils/patternAnalysis.ts`。页面入口分别位于 `src/app/analysis/page.tsx`、`src/app/warehouse/page.tsx`、`src/app/projects/page.tsx`。

## Python 主流程

命令均从仓库根目录执行。

### 1. group_similar_pattern_images.py

目标：将原始截图归成同一图纸的 ImageN 分组，生成下游识别使用的 manifest。

- 输入：`.cursor/tmp/img/`；新增批次使用 `.cursor/tmp/img-new/`。
- 输出：`results/processing/1.grouped-images/` 中的分组截图和 `results/processing/1.grouped-images/` 中的 manifest。
- 使用布局分类、OCR pairKey、pHash/dHash、颜色直方图和裁剪缩略图判定分组，优先比较邻近截图。
- 页面分类包括 detail_page、summary_view、color_modal、unknown。
- 多页输出为 `ImageN/ImageN_1.ext` 等，单页为 `ImageN.ext`。manifest 保留源路径、页面类型、pairKey 和分组依据。
- `--no-paddle` 支持关闭 PaddleOCR 回退。

```powershell
python scripts/python/group_similar_pattern_images.py .cursor/tmp/img --out results/processing/1.grouped-images --action copy --manifest results/processing/1.grouped-images/groups.manifest.json
```

### 2. analyze_color_legend.py

目标：从图例识别每张图纸的色号和数量，生成颜色统计及可复核证据。

输入支持 manifest、单张图片或图片目录。详情页采样底部圆点并匹配 MARD Lab 颜色，结合预处理 OCR 投票、OpenCV 模板和 Tesseract token 识别数量。多页同色数据合并，并使用分组 pairKey 的预期总数核对。

主流程调用同目录的 `analyze_color_modal_legend.py` 处理颜色弹窗。debug 保留数量候选、投票来源、冲突及实际解析页；main 输出 colorCounts、sourceImages、needsReview 等。弹窗 main 展示来源可映射到首张图，debug 保留真实弹窗页。

```powershell
python scripts/python/analyze_color_legend.py --manifest results/processing/1.grouped-images/groups.manifest.json --out results/processing/2.groupped-bead-count/analyze_color_legend.debug.json
```

输出为 `results/processing/2.groupped-bead-count/analyze_color_legend.debug.json` 和 `analyze_color_legend.main.json`，也是批处理默认输出位置。项目服务读取该目录的 main。用户确认四张新增图纸后，新增 main、debug 和分组清单已分别合入正式文件，三个 `.new` 文件已删除。

2026-09-11 合并验证：按图纸 ID 检查无重名，逐项确认正式与新增图纸记录在合并后保持一致。主清单为 35 组、56 张截图，main/debug 均为 37 张图纸，冲突数为 0。历史 Image35、Image36 已存在于识别统计但未列入主分组清单，合并保留其记录；已删除的 Image19 未恢复。

## 数据阶段与实际运行方式

```text
results/
  app/
    1.source-images/           Stage 1：上传原图副本
    2.grid-detection/          Stage 2：网格检测 JSON、叠加图、文字掩码
    3.parsed-grid/             Stage 3：每格色号及用豆统计的网格 JSON
    projects/                 项目和图纸副本
    warehouse/                库存及交易
  processing/
    1.grouped-images/          分组截图及 manifest
    2.groupped-bead-count/     用豆统计及识别证据
```

Stage 1 和 Stage 3 在网页点击保存时一起写入。Stage 2 现有文件是 v3 脚本生成的 geometry JSON、SVG 网格叠加图和 PNG 文字掩码，网页没有直接读取这些文件。

网页 `/api/analysis/grid-geometry` 调用 `scripts/python/prototype_grid_geometry_v2.py`，将输入及输出放入 `.grid-python/<请求ID>/`，读取检测结果后在 finally 中删除临时目录。此次修正其旧脚本路径，保留上述运行方式。Stage 2 的网页持久化属于后续计划。

2026-09-11 阶段迁移：同步更新页面 API、项目服务、库存服务、JS/Python 默认路径及已有 JSON 路径。历史批量统计移入 processing 第 2 阶段；分组清单合入第 1 阶段。经全文与 SHA-256 比较确认 archived 与主清单完全一致，已删除重复副本。v3 默认目录改为当前仓库的 Stage 2 路径。

验证：TypeScript、5 项豆仓测试及 Python 语法检查通过。v2 脚本以 `results/app/1.source-images/2026-08-13_185017_karbi_original.jpg` 为输入，在 `.cursor/tmp/stage-check/` 成功生成 geometry JSON 和 SVG。此次验证覆盖实际脚本执行；网页端到端交互未重测。

### 3. prototype_grid_geometry_v3.py

目标：单张图纸的网格几何、文字中心和叠加预览实验，用于调试定位。

`--image` 指定图片，`--grid-size` 指定板尺寸，`--out-dir` 指定输出目录。v2 保留上一版实验实现。这是独立的网格实验流程。

### 其他 Python 工具

| 文件（相对 scripts/python/） | 目标和结果 |
| --- | --- |
| `analyze_color_modal_legend.py` | 识别弹窗的圆点网格、色号和数量；独立运行输出 debug、final、compare JSON 至 `test_scr/output/`。 |
| `test_scr/calc_remaining_inventory.py` | 根据选中图纸和库存文本计算剩余库存，输出终端报告。 |
| `test_scr/delta_e_substitutions.py` | 使用 CIEDE2000 寻找替代色，支持指定图片、豆数、排除项；`--apply` 写入替换结果。 |
| `final_review_gate.py` | 终端交互式复核工具，读取后续输入并在收到退出指令时结束。 |

## JavaScript 工具

文件位于 `scripts/javascript/`，数据路径以仓库根目录为基准。

| 文件 | 目标 | 入口和产物 |
| --- | --- | --- |
| `seed-warehouse.js` | 初始化指定 MARD 色板和每色库存 | `npm run seed:warehouse`；写入 `results/app/warehouse/inventory.json`。 |
| `create-warehouse.js` | 按名称、色板和数量创建豆仓 | `npm run create:warehouse`；支持 `--append`、`--out`、`--palette`、`--count`。 |
| `calc-project-requirements.js` | 根据图纸 JSON 和库存计算项目需求及缺豆 | `npm run calc:project -- --input 配置.json`；生成项目和需求结果。 |
| `export-pattern-stats-csv.js` | 导出单张网格图纸颜色统计 | `npm run export:pattern-stats -- --pattern 文件.grid.json --out 统计.csv`。 |
| `generate-icons.js` | 生成应用图标 | `node scripts/javascript/generate-icons.js`；写入 `public/`。 |
| `generate-cert.js` | 生成本地 HTTPS 证书 | `node scripts/javascript/generate-cert.js`；写入 `certificates/`，供根目录 `server.js` 使用。 |

## 开发记录

### 2026-08-14：豆仓

完成创建、修改库存、文本补货、交易删除回滚和项目绑定删除保护。新增豆仓删除与交易删除测试，覆盖其他豆仓数据隔离。

### 2026-08-21：弹窗识别整合

弹窗解析整合到主流程。扫描范围扩大到弹窗高度约 8%–96%，通过多阈值 Hough 圆检测按行排序，每行最多 6 个圆，修复 Image4 底部漏检。采样匹配距离小于等于 2.0 时保留匹配，否则参考圆内 OCR。Image4 E5、E16 的零距离匹配得到保留。

数量识别保留多个候选，冲突加入 needsReview；与预期总数相符的候选生成 suggestedCorrection。

历史批次 32 张图纸人工复核后记录为 conflictCount=0、remainingReviewImages=0。已确认修改：Image4 A8 从 98 改为 58；Image5 H2 从 93 改为 53。已确认正确：Image5 A20=532、G6=1，Image24 F21=53。

弹窗验收样例：Image4 52_2955、Image5 31_2652、Image24 27_1426、Image26 30_2356、Image28 5_893。上述数字是当时批次的历史复核记录。

### 2026-09-11：目录整理

原图统一到 `.cursor/tmp/img/`，新增批次位于 `.cursor/tmp/img-new/`。新增批次产物包含 Image13、Image21、Image37、Image38，以及 `groups.new.manifest.json`。

Python 工具移至 `scripts/python/`，JS 工具移至 `scripts/javascript/`，测试移至 `scripts/tests/`。同步更新根路径计算、npm 命令、测试导入及 HTTPS 提示命令。

网格数据移至 `results/app/3.parsed-grid/`，配套原图移至 `results/app/1.source-images/`，保存 API 和已有图纸路径已同步。新增批次图例结果直接存于 `results/processing/2.groupped-bead-count/`。

开发文档统一到 `doc/`；原 Python 日志整理为本文件，增加应用分层、JS 工具目标与开发记录。功能文档更新为已实现功能及完成记录。

上一轮目录迁移验证：TypeScript 检查、5 项豆仓测试、Python 语法及主脚本帮助入口通过。

本轮 JS 迁移验证：6 个 JS 工具的 Node 语法检查通过，TypeScript 检查及 5 项豆仓测试通过。使用已有网格图纸经 npm 导出入口成功生成 15 色 CSV，验证文件位于 `.cursor/tmp/structure-check/pattern-stats.csv`。
