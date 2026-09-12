<div align="center">

# ✦ Perler Beads Generator ✦

### 任意图片 → 拼豆底稿，一键生成

[![Mobile](https://img.shields.io/badge/移动端-perlerbeadsold.zippland.com-ff69b4?style=for-the-badge)](https://perlerbeadsold.zippland.com)
[![Desktop](https://img.shields.io/badge/桌面端-perlerbeads.zippland.com-8b5cf6?style=for-the-badge)](https://perlerbeads.zippland.com)
[![License](https://img.shields.io/badge/License-AGPL%20v3-blue?style=for-the-badge)](./LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-Welcome-brightgreen?style=for-the-badge)](https://github.com/Zippland/perler-beads/pulls)

开源的智能拼豆图纸生成器 — 自动颜色映射 · 多品牌色号适配 · 杂色清理 · 一键导出图纸与采购清单

**移动端**（竖屏）：快速生成图纸，适合手机使用 · **桌面端**（横屏）：完整工作台，适合电脑精细编辑

</div>

---

## 功能

- **智能像素化** — 基于主导色提取的像素化算法，消除传统均值池化导致的灰色毛边
- **多色板适配** — 内置 5 大品牌色号体系（MARD / COCO / 漫漫 / 盼盼 / 咪小窝），支持 168 / 144 / 96 等多种色板规格
- **自动颜色合并** — BFS 连通区域检测 + 可调相似度阈值，自动清理杂色
- **背景智能移除** — 边界洪水填充算法自动识别并剥离外部背景
- **颜色排除与重映射** — 一键排除不想要的颜色，自动重映射到最近似可用色
- **手动精修** — 支持对单个像素格进行手动着色和修改
- **导出图纸** — 下载带色号标注和网格线的 PNG 图纸，可直接打印使用
- **导出采购清单** — 自动统计各颜色用量，生成采购清单图

## 快速开始

```bash
git clone https://github.com/Zippland/perler-beads.git
cd perler-beads
npm install
npm run dev
```

浏览器打开 `http://localhost:3000`，或按需指定端口：

```bash
npm run dev -- -p 3000
```

## 批量截图处理流程

待处理原图统一放在仓库内：

```text
.codex/tmp/img/
```

这个目录用于临时导入新截图，不提交到 git。旧的桌面临时目录如 `C:\Users\z5308\Desktop\more` / `C:\Users\z5308\Desktop\img` 只作为外部暂存，不作为项目标准路径。

### 1. 分组截图

把 `.codex/tmp/img` 里的 iPad 截图分组成 `ImageN`：

```bash
python scripts/python/group_similar_pattern_images.py .codex/tmp/img --out results/processing/1.grouped-images --action copy --manifest results/processing/1.grouped-images/groups.manifest.json
```

输出：

- 分组图片：`results/processing/1.grouped-images/`
- 分组清单：`results/processing/1.grouped-images/groups.manifest.json`

### 2. 识别颜色图例

基于分组清单读取每个图纸的底部色号/数量：

```bash
python scripts/python/analyze_color_legend.py --manifest results/processing/1.grouped-images/groups.manifest.json --out results/processing/2.groupped-bead-count/analyze_color_legend.debug.json
```

输出：

- 调试结果：`results/processing/2.groupped-bead-count/analyze_color_legend.debug.json`
- 识别结果：`results/processing/2.groupped-bead-count/analyze_color_legend.main.json`

项目页面读取该目录的 `analyze_color_legend.main.json`。当前活动统计共 30 张图纸，另有 7 张已完成图纸归档到 `results/processing/3.done-images/`。分组清单与活动截图统一放在 `results/processing/1.grouped-images/`。

### 完成图纸与扣库

使用已复核的正式图例，预览指定图纸的完成操作：

```powershell
python scripts/python/complete_images.py --images 3 6 8 --warehouse warehouse-1
```

支持 `3,6,8`、`3 6 8`、`Image3 Image6 Image8`；省略 `--images` 时提示输入。确认图例和预览后，停止网页服务，再执行：

```powershell
python scripts/python/complete_images.py --images 3 6 8 --warehouse warehouse-1 --apply
```

脚本扣除逐色库存，每图追加一笔流水，将全部截图和完整图例移入 `results/processing/3.done-images/`，汇总保存在 `done-count.json`。项目中对应的图纸记录及原项目关系随图归档，活动项目需求和分配索引同步更新。已完成且记录一致的 ID 会跳过。

一次只运行一个修改数据的脚本。操作备份保留在 `results/processing/.completion-operations/`，不提交 Git。异常中断后先重新运行脚本，启动时会恢复未完成操作，再进行预览；恢复成功前不要启动网页或手动修改相关数据。正常完成后可重新 `npm run dev`，豆仓流水显示归档图片，归档完成流水不能单独删除。

脚本测试：`python -m unittest discover -s scripts/tests -p test_complete_images.py -v`。

### 3. 网格几何实验脚本

`scripts/python/prototype_grid_geometry_v3.py` 是单张图纸的网格几何/文字中心检测实验脚本，不属于上面的 batch 截图主流程。只有在调试裁剪、网格定位、文字中心检测时才单独使用。

## 目录说明

库存统一维护于 `results/app/warehouse/`，网页和脚本共用：

- `inventory.csv`：两仓当前库存，包含豆仓 ID、名称、色板、时间、色号、Hex、数量、额外色标记和备注。
- `transactions.csv`：出入库流水，包含交易 ID、时间、类型、前后数量、增减量及项目/图纸关联字段。

`warehouse-1` 为亚麻96仓，仅包含标准 MARD 96 色，每色 541 颗，共 51,936 颗；`warehouse-221` 为 MARD 221，共 243,000 颗。完整列定义见 [CSV 数据说明](doc/warehouse-csv.md)。

```powershell
python scripts/python/helpers/calc_remaining_inventory.py --warehouse warehouse-221 --selected Image13 Image21 --only-used
```

- `doc/feature-docs.md`：已实现功能和完成记录。
- `doc/development-log.md`：开发日志、主要脚本目标、输入输出和应用代码分层。
- `src/`：网站页面、API、组件、服务及图像算法代码。
- `scripts/javascript/`：手动执行的 JavaScript 工具。
- `scripts/tests/`：TypeScript 测试，通过 `npm run test:warehouse` 运行。
- `scripts/python/`：全部 Python 脚本；库存辅助工具位于 `helpers/`，实验和 Python 回归测试位于 `test_scr/`。
- `.codex/tmp/img/`：待处理原图，Git 忽略此目录。
- `results/app/3.parsed-grid/`：原 `patterns/`，保存分析页面导出的网格数据、色号和数量（`.grid.json`）。
- `results/app/1.source-images/`：原 `pic/`，保存与网格 JSON 配套的上传原图。
- `results/processing/1.grouped-images/`：批处理脚本按 `ImageN` 分组后的截图。
- `results/processing/2.groupped-bead-count/`：颜色图例识别结果，直接保存文件。
- `results/app/projects/`：项目数据和项目内部的图纸副本。

以上脚本命令均从仓库根目录运行。

## 技术栈

| 层 | 技术 |
|---|------|
| 框架 | Next.js (React) + TypeScript |
| 样式 | Tailwind CSS |
| 图像处理 | Canvas API（浏览器端） |
| 部署 | Vercel |

## 核心算法

### 1. 初始颜色映射

对每个网格单元，提取原图对应区域内出现频率最高的像素 RGB 值（主导色），通过欧氏距离映射到当前色板中最接近的颜色。相比均值池化，主导色提取有效避免了色块边界处的灰色毛边问题。

### 2. 区域颜色合并

使用 BFS 从未访问单元格出发，将欧氏距离小于阈值的邻近单元格聚合为连通区域，统一设置为区域内出现次数最多的色号。该步骤显著减少杂色，提升色块纯净度。

### 3. 背景移除

定义背景色号列表，从所有边界单元格执行洪水填充，标记与边界连通且属于背景色的单元格为"外部"。统计和导出时忽略外部单元格，实现自动背景剥离。

### 4. 颜色排除与重映射

当用户排除某颜色时，在当前存在且未被排除的颜色子集中寻找最近似替代色进行重映射。恢复颜色时触发完整的重处理流程。

### 调色板数据

色板数据定义在 [`src/app/colorSystemMapping.json`](src/app/colorSystemMapping.json)，包含 291 种标准颜色到 5 个品牌色号体系的完整映射。色板组合在 [`src/app/page.tsx`](src/app/page.tsx) 的 `paletteOptions` 中配置。

## Roadmap

- [ ] CIEDE2000 (Delta E) 颜色距离算法，替代 RGB 欧氏距离
- [ ] Floyd-Steinberg 抖动，在有限色板下模拟更丰富的颜色过渡
- [ ] Web Workers 后台计算，优化大图性能
- [ ] 用户自定义调色板上传
- [ ] 微信小程序版本

## 参与贡献

欢迎提交 Issue 和 Pull Request。

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/your-feature`)
3. 提交更改 (`git commit -m 'Add some feature'`)
4. 推送到分支 (`git push origin feature/your-feature`)
5. 创建 Pull Request

## 共创声明

本项目永久开源，由维护者无偿运营 [perlerbeadsold.zippland.com](https://perlerbeadsold.zippland.com) 供所有拼豆爱好者免费使用。

我们公开全部算法细节和源代码，目的是推动拼豆工具生态的共同进步。欢迎所有人学习、使用、改进。

**但请勿将本项目代码恶意抄袭后包装为闭源商业产品。** 这一行为违反开源协议，也伤害每一位贡献者的热情。使用本项目代码的衍生作品须遵守许可证条款，保留原始版权声明，并以相同协议开源。

## 许可证

[AGPL-3.0](./LICENSE) &copy; [Zippland](https://github.com/Zippland)



