# Python 脚本

从仓库根目录执行以下命令。`processing` 的阶段编号对应 `results/processing`，与 `results/app` 的原图、检测、解析阶段分别管理。

| 脚本 | 用途 |
| --- | --- |
| `processing/stage1_group_images.py` | Stage 1：同图纸截图分组，生成 manifest |
| `processing/stage2_analyze_bead_counts.py` | Stage 2：识别图例，生成用豆统计 main/debug JSON |
| `processing/stage2_analyze_helper_modal_legend.py` | Stage 2 弹窗识别模块，也可独立调试 |
| `processing/stage3_complete_images.py` | Stage 3：完成图纸、扣库和归档；默认预览，`--apply` 提交 |
| `app/detect_grid_geometry_v1.py` | 网页 API 调用的网格检测，原 prototype v2 |
| `experiments/grid_geometry_v2.py` | 网格检测实验，原 prototype v3 |
| `helpers/create_inventory_csv.py` | 生成库存导入 CSV |
| `helpers/calculate_remaining_inventory.py` | 计算选中图纸用豆后的库存，只读 |
| `helpers/substitute_colors.py` | 按色差与库存寻找替代色，`--apply` 写入统计 |
| `helpers/wait_for_review.py` | 终端复核输入循环；由 `.codex/plan/reviewgate.mdc` 引用，业务代码未调用 |

```powershell
python scripts/python/processing/stage1_group_images.py .codex/tmp/img --out results/processing/1.grouped-images --action copy --manifest results/processing/1.grouped-images/groups.manifest.json
python scripts/python/processing/stage2_analyze_bead_counts.py --manifest results/processing/1.grouped-images/groups.manifest.json
python scripts/python/processing/stage3_complete_images.py --images 3 6 8 --warehouse warehouse-1
python scripts/python/app/detect_grid_geometry_v1.py --image path/to/image.png --out-dir path/to/output
python scripts/python/experiments/grid_geometry_v2.py --image path/to/image.png
python -m unittest discover -s scripts/tests -p test_complete_images.py -v
```

网格检测的输出文件及 mode 编号随脚本调整为 v1/v2；已有历史结果不改写。实验版默认输出至 `results/app/2.grid-detection/`，弹窗独立调试输出至 `results/processing/debug/modal-legend/`。

旧 `test_scr/groups.manifest.json` 与正式版本不同，已保留到 `.codex/tmp/groups.manifest.legacy.json`；正式入口继续使用 `results/processing/1.grouped-images/groups.manifest.json`。自动化测试统一位于 `scripts/tests/`。
