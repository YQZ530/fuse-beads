# 开发日志

## 2026-09-11：恢复 Image32 已确认图例

按用户确认将正式 main 中 Image32 恢复为 G13=280、H2=154、H6=88、H3=82、B17=42、G8=40、A20=10、F5=3、F8=3、H4=2、F24=1，共11色705颗，与原有debug及项目副本一致。清空改色方案的Image32旧替换和额外购买项，保留selected。Image32保持draft、未归档未扣库；Image33的完成记录、两仓库存及流水不变。

## 2026-09-11：完成图纸脚本与首次归档

实现 `scripts/python/complete_images.py`，默认预览，`--apply` 提交。脚本校验图例、库存、图片与重复完成状态，逐图扣库并追加逐色流水；归档截图、完整 main/debug、manifest 分组和项目图纸记录，更新活动图例、分配索引及项目需求。备份与阶段日志保存在 `results/processing/.completion-operations/`；捕获错误回滚，异常中断后下次启动先恢复，恢复遇到外部修改时停止。

复用图纸图片 API，收紧为指定图片目录和位图扩展名，验证真实路径以阻止越界。豆仓流水增加归档缩略图，服务端保护完成流水及关联豆仓，避免删除后破坏完成记录。根 tsconfig 保留拆分结构，补 compilerOptions 对象，并为继承配置设置 baseUrl，修复 Next 启动及路径别名解析。

实际完成 Image3/6/8/21/33/37/38，共 7 张、4,409 颗、59 条逐色流水。亚麻96仓由 51,936 扣至 47,527；221 仓保持 243,000。活动 main/debug 剩 30 张，manifest 剩 28 组、49 张截图。亚麻96项目归档 Image3/6/8 后只剩 Image32，需求 705，缺口 41（A20=10、F24=1、G13=30）。重复执行无额外扣库。

验证：15 项 Python 测试、13 项仓库存储测试及 TypeScript 检查通过；真实数据临时副本与网页现有项目计算逐项一致，其他图例和221仓数据不变。HTTP 验证 /warehouse、/projects、库存接口和7张归档图片返回200，越界及非图片路径返回400，删除完成流水返回400且库存不变。浏览器连接不可用，未做可视化点击验收。

## 2026-09-11：同步已确认 legend 与 debug

Image3（4 色、230 颗）、Image8（8 色、705 颗）的已确认配色同步至 debug 的汇总、页面明细和校验字段。Image33 正式统计及 debug 更新为 E2=122、D20=87、D12=82、H2=81、F9=45、F14=40、E8=23、F11=11、E4=6、C7=2，共 10 色、499 颗；改色方案清空该图旧替换和额外购买项，保留 selected。

这三张图的 debug 有效统计标记为 user_confirmed，原始 OCR 证据保存在各图 originalOcr 字段中。透明格数保持不变。项目图纸副本与已确认统计一致，库存和流水保持不变。

## 2026-09-11：确认 Image3 与 Image8 配色

Image3 按用户指定替换 F15→F5、A26→A13、A8→F8，F8 合并为 59。正式结果为 F5=64、H7=54、A13=53、F8=59，共 4 色、230 颗。

Image8 采用用户逐色确认值：G5=245、A4=176、F5=117、F10=74、A6=55、F8=20、G13=12、F7=6，共 8 色、705 颗，替代旧改色方案。同步正式统计和项目图纸副本；debug 保留原始 OCR 证据，库存和流水保持不变。

## 2026-09-11：恢复 Image3 原始配色

对照原图及 debug，撤销 F15→F8、A8→A4、A26→A3。正式统计恢复 F15=64、H7=54、A26=53、A8=43、F8=16，合计 5 色、230 颗，expected=5_230。改色方案中的 Image3 替换项清空，保留 selected 状态。项目副本已是原配色；其他图纸、库存和流水保持不变。

## 2026-09-11：确认标准96色

用户确认亚麻仓仅包含标准 MARD 96 色。按色板清单核对并移除 A5、A8、B1、B4、B6，现为 96 色，每色 541 颗，总数 51,936。221 仓数据及空流水保持不变。

## 2026-09-11：重置起始库存

按用户确认清空全部 7 笔测试/迁移流水，transactions.csv 保留表头。亚麻仓全部 101 个现有色号（含 5 个额外色）统一为 541 颗，共 54,641 颗，备注更新为确认后的起始库存。221 仓逐项保持原值，共 243,000 颗。此次直接设定起始库存，不生成新流水。

## 2026-09-11：统一库存和流水 CSV

正式存储统一为 `results/app/warehouse/inventory.csv` 与 `transactions.csv`。文件名、列名及新建 ID 使用英文/ASCII，豆仓名称为显示字段。完整列定义见 `warehouse-csv.md`。

新增共享读写层 `src/lib/warehouseCsv.js`，由网页存储服务及 JS 工具调用，使用 csv-parse / csv-stringify 处理引号、多行备注和 UTF-8。记录按 warehouseId、transactionId 分组，保留空流水事件；写入采用跨进程锁和可恢复的双 CSV 暂存，格式错误直接报错。

亚麻仓使用用户确认的 CSV 数量 52,536，保留原仓 ID、时间及原始流水。原有 5 个额外色以零库存保留元数据，差额写入调整流水。MARD 221 导入 243,000 颗，ID 为 warehouse-221，新增期初流水。迁移逐项校验元数据、旧交易及总数后，旧文件存档至 `doc/archive/warehouse-before-csv/`，文件名为 legacy-inventory.json、linen96-source.csv、mard221-source.csv。正式读写仅使用新的两个 CSV。

网页豆仓及项目需求服务改为读取统一 CSV，创建、补货、修改、改名、删除和流水回滚均通过同一存储层。Python 库存与配色辅助工具通过 `--warehouse` 选择仓库，默认 warehouse-1。JS 创建脚本追加豆仓并拒绝重复 ID；初始化脚本拒绝覆盖已有库存。

验证：11 项存储测试和 TypeScript 检查通过；Python 实际读取两仓通过。/warehouse、/projects、/api/warehouse/list、/api/projects/list 返回 200；HTTP 创建、更新、补货、回滚和删除验证通过，临时测试仓已清理，真实库存与测试前完全一致。浏览器连接不可用，本次未做可视化点击验收。开发服务运行于 http://localhost:3000。

## 2026-09-11：两份库存 CSV（迁移前记录）

原 `亚麻色系库存.txt` 已采用 CSV 内容，统一命名并移至 `results/app/warehouse/亚麻96仓.csv`，数量保持不变：96 色、52,536 颗，H2/H7 各 841 颗，其余各 541 颗。库存及替代色辅助脚本的默认读取路径同步更新。

按用户确认删除“大图”项目及其分配记录，删除 `warehouse-星芒144` 豆仓和对应交易。亚麻96仓保留现有网页数量，CSV 本次仅统一名称，尚未同步数量。

`results/app/warehouse/MARD221库存.csv` 按仓库 MARD 221 色板生成，每色基础 1000 颗。已确认额外购入 H2/H7 各 5000；B17、F8、A20、D3、E2、G7、G18、H9 各 1000；F15/H16 各 2000。F8 的两次提及对应同一笔 1000 颗补购。共 221 色、243,000 颗。

两份 CSV 使用 `colorKey,ownedCount,note` 字段，尚未接入网页库存同步。新增 `scripts/python/helpers/create_inventory_csv.py` 可根据色板、基础库存和补购参数生成 CSV；输出已存在时拒绝覆盖。

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
    helpers/                 库存计算等辅助工具
    test_scr/                配色实验和 Python 回归测试
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

- 输入：`.codex/tmp/img/`；新增批次使用 `.codex/tmp/img-new/`。
- 输出：`results/processing/1.grouped-images/` 中的分组截图和 `results/processing/1.grouped-images/` 中的 manifest。
- 使用布局分类、OCR pairKey、pHash/dHash、颜色直方图和裁剪缩略图判定分组，优先比较邻近截图。
- 页面分类包括 detail_page、summary_view、color_modal、unknown。
- 多页输出为 `ImageN/ImageN_1.ext` 等，单页为 `ImageN.ext`。manifest 保留源路径、页面类型、pairKey 和分组依据。
- `--no-paddle` 支持关闭 PaddleOCR 回退。

```powershell
python scripts/python/group_similar_pattern_images.py .codex/tmp/img --out results/processing/1.grouped-images --action copy --manifest results/processing/1.grouped-images/groups.manifest.json
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
| `helpers/calc_remaining_inventory.py` | 读取正式用豆统计及库存文本，汇总选中图纸的各色用量，输出 owned、used、remaining 终端表格。 |
| `test_scr/delta_e_substitutions.py` | 使用 CIEDE2000 寻找替代色，支持指定图片、豆数、排除项；`--apply` 写入替换结果。 |
| `final_review_gate.py` | 终端交互式复核工具，读取后续输入并在收到退出指令时结束。 |

## JavaScript 工具

文件位于 `scripts/javascript/`，数据路径以仓库根目录为基准。

| 文件 | 目标 | 入口和产物 |
| --- | --- | --- |
| `seed-warehouse.js` | 初始化空豆仓存储 | `npm run seed:warehouse`；写入 `results/app/warehouse/inventory.csv` 和 `transactions.csv`。 |
| `create-warehouse.js` | 按名称、色板和数量追加豆仓 | `npm run create:warehouse`；支持 `--out`、`--palette`、`--count`，保留现有豆仓。 |
| `calc-project-requirements.js` | 根据图纸 JSON 和库存计算项目需求及缺豆 | `npm run calc:project -- --input 配置.json`；生成项目和需求结果。 |
| `export-pattern-stats-csv.js` | 导出单张网格图纸颜色统计 | `npm run export:pattern-stats -- --pattern 文件.grid.json --out 统计.csv`。 |
| `generate-icons.js` | 生成应用图标 | `node scripts/javascript/generate-icons.js`；写入 `public/`。 |
| `generate-cert.js` | 生成本地 HTTPS 证书 | `node scripts/javascript/generate-cert.js`；写入 `certificates/`，供 `scripts/javascript/server.js` 使用。 |
| `server.js` | 启动本地 HTTPS 服务 | `npm run dev:https`；默认端口 3002，读取根目录 `certificates/`。 |

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
