# 已实现功能

更新日期：2026-09-11

## 功能入口

- 主要页面：`src/app/warehouse`
- 主要 API：`src/app/api/warehouse`
- 主要数据文件：`results/app/warehouse/inventory.json`
- 主要服务逻辑：`src/lib/warehouseStore.ts`

## 图纸分析

- `/analysis` 提供解析、优化和编辑视图。
- 支持加载图片、裁剪确认、检测网格及调整网格边界和行列数。
- 支持图纸预览、缩放、按颜色分组查看及选择校正。
- 解析结果包含每格颜色和颜色用量，可保存为 `.grid.json`。
- 网格 JSON 保存到 `results/app/3.parsed-grid/`，配套上传原图保存到 `results/app/1.source-images/`。

## 项目

- `/projects` 提供项目列表，`/projects/[id]` 提供项目详情。
- 项目关联豆仓及图纸，汇总颜色需求与库存缺口。
- 项目数据保存在 `results/app/projects/`。

## 已完成功能

### 我的豆仓

- `/warehouse` 页面提供“我的豆仓”区域。
- 没有豆仓时显示空状态，不强制展示不存在的数据。
- “我的豆仓”标题右侧有 `+` 按钮。
- 点击 `+` 展开“新建豆仓”表单。
- 新建豆仓可选择 MARD 色板、设置初始库存数量。
- 新建成功后自动切换到新豆仓。

### 颜色库存

- 颜色库存按色号系列分组，例如 A、B、C、D、H、M 等。
- 颜色库存标题右侧可折叠/展开。
- 系列入口以圆形色号系列按钮展示。
- 点击系列后显示该系列下的颜色库存列表。
- 列表默认每页显示 20 条。
- 分页选择支持 `10 / 20 / 50`。
- 每个库存行显示色号、颜色方块、Hex、来源、库存数量和保存按钮。
- 库存数量可手动修改，保存后写入 JSON 并生成库存记录。

### 补货导入

- 页面提供“补货导入”表单。
- 支持粘贴文本格式，例如 `T1-500`、`T1 500`、`T1,500`、`R11：100`。
- 导入前提供解析预览。
- 同色号多行会合并数量。
- 无法识别的行会显示错误原因。
- 补货导入会累加库存，不覆盖现有库存。
- 如果补货色号不在当前豆仓基础色板里，但存在于 MARD 291，会作为额外颜色加入该豆仓。
- 新补货记录默认 note 为 `补货导入`。

### 最近库存记录

- 页面显示最近库存记录。
- 每条记录显示类型、时间和净变化，例如 `补货 2026/8/13 21:04:10 净变化 +16 颗`。
- 记录类型展示文案：
  - `manual_replenishment` -> `补货`
  - `manual_adjustment` -> `修改库存`
  - `create_warehouse` -> `创建豆仓`
- 旧 note 展示时会兼容归一化：
  - `豆仓页面手动修改库存` -> `修改库存`
  - `手动修改库存` -> `修改库存`
  - `手动补货导入` -> `补货导入`
- 有明细的记录提供 `详情 / 收起`。
- 展开详情后显示 note 和每个色号的变化数量。
- 每个明细色号旁显示颜色方块。
- 展开区域有边框、最大高度限制，内容超出后内部滚动。
- 每条库存记录可删除。
- 删除库存记录前会确认：`确定删除这条库存记录吗？只会删除记录且回滚库存数量。`
- 删除库存记录会删除该 transaction，并按 delta 回滚库存数量。

### 删除豆仓

- 最近库存记录下方有单独“删除豆仓”危险区域。
- 区域说明：删除后会从 `results/app/warehouse/inventory.json` 移除这个豆仓和它的库存记录。
- 按钮文案为 `删除`，执行中为 `删除中`。
- 删除前会确认豆仓名和不可撤销风险。
- 删除豆仓会从 `results/app/warehouse/inventory.json.warehouses` 移除对应豆仓。
- 删除豆仓会同步移除该豆仓相关 `transactions`。
- 如果有 project 绑定该豆仓，后端会拒绝删除。

### 项目需求摘要

- 豆仓页面会读取项目需求摘要。
- 当前豆仓可显示计划需求、缺豆、缺色、计划色等指标。

## 数据与 API

### 数据存储

- 当前豆仓库存使用 JSON 存储。
- 主文件为 `results/app/warehouse/inventory.json`。
- 库存记录存放在 `inventory.transactions`。
- 补货导入使用文本解析输入，后端保存 JSON 库存记录。

### API Routes

- `GET /api/warehouse/list`
  - 读取库存、MARD 色板选项、MARD 291 全色、项目需求。
- `POST /api/warehouse/create`
  - 新建豆仓并写入 `inventory.json`。
- `POST /api/warehouse/update-item`
  - 修改单个色号库存并生成 `修改库存` transaction。
- `POST /api/warehouse/replenish`
  - 批量补货，累加库存并生成 `补货导入` transaction。
- `POST /api/warehouse/delete`
  - 删除豆仓和该豆仓库存记录。
- `POST /api/warehouse/delete-transaction`
  - 删除单条库存记录并回滚库存数量。

## 测试

- 新增测试配置：`tsconfig.warehouse-tests.json`
- 新增测试命令：`npm run test:warehouse`
- 当前测试文件：`scripts/tests/warehouseStore.delete.test.ts`
- 已覆盖：
  - 删除豆仓会移除目标豆仓和目标 transactions。
  - 删除豆仓不会误删其他豆仓和其他 transactions。
  - 项目绑定中的豆仓不能删除。
  - 删除正 delta 记录会回滚库存。
  - 删除负 delta 记录会回滚库存。
  - 不能从当前豆仓删除其他豆仓的 transaction。

## 已验证

- `npx tsc --noEmit --incremental false`
- `npm run test:warehouse`
- `/warehouse` 本地返回 `200`

## 完成记录

- 2026-09-11：应用结果按原图、网格检测和已解析网格三个阶段归入 `results/app/`；分组截图及 manifest、用豆统计归入 `results/processing/`，项目和豆仓读取路径同步迁移。
- 2026-09-11：修复网页网格检测接口对迁移后 Python v2 脚本的调用路径。

- 2026-08-14：完成豆仓创建、颜色库存分组、文本补货、库存记录明细、删除回滚和项目绑定保护。
- 2026-09-11：图纸保存目录统一为 `results/app/3.parsed-grid/` 和 `results/app/1.source-images/`，同步更新已有图纸的原图引用。
- 2026-09-11：开发工具按 JavaScript、Python 和测试分类；README 与开发日志补齐目录用途及执行入口。
