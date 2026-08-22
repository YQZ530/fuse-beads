# 豆仓 Feature Docs

Last updated: 2026-08-14

## Scope

- 工作目录：`C:\Users\z5308\Desktop\perler-beads-batch_analy2`
- 主要页面：`src/app/warehouse`
- 主要 API：`src/app/api/warehouse`
- 主要数据文件：`results/warehouse/inventory.json`
- 主要服务逻辑：`src/lib/warehouseStore.ts`
- 豆仓开发不改 `/analysis`、`/projects` 的大逻辑。

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
- 区域说明：删除后会从 `results/warehouse/inventory.json` 移除这个豆仓和它的库存记录。
- 按钮文案为 `删除`，执行中为 `删除中`。
- 删除前会确认豆仓名和不可撤销风险。
- 删除豆仓会从 `results/warehouse/inventory.json.warehouses` 移除对应豆仓。
- 删除豆仓会同步移除该豆仓相关 `transactions`。
- 如果有 project 绑定该豆仓，后端会拒绝删除。

### 项目需求摘要

- 豆仓页面会读取项目需求摘要。
- 当前豆仓可显示计划需求、缺豆、缺色、计划色等指标。
- 该部分只消费 project demand 数据，不改 `/projects` 大逻辑。

## 数据与 API

### 数据存储

- 当前豆仓库存使用 JSON 存储。
- 主文件为 `results/warehouse/inventory.json`。
- 库存记录存放在 `inventory.transactions`。
- 当前没有实现 CSV 文件作为持久化存储。
- 补货导入当前是“文本解析输入 -> 后端写入 JSON transaction”，不是 CSV 文件导入。

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
- 当前测试文件：`tests/warehouseStore.delete.test.ts`
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

## 当前 Assumptions

- 豆仓线以 `results/warehouse/inventory.json` 为当前事实来源。
- 交易记录先以 JSON transaction 形式保存，不引入 CSV 持久化。
- 删除 transaction 的语义是删除记录且回滚库存数量。
- 删除豆仓的语义是删除豆仓本身和它的 transaction。
- 被 project 绑定的豆仓不能删除，避免项目引用悬空。
- 额外颜色只允许从 MARD 291 全色中补入。
