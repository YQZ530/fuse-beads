# 本地版拼豆项目管理计划

## 目标

把当前拼豆生成器从“单次生成与编辑工具”扩展为本地项目管理工具：

1. 用户编辑完成后，可以手动保存项目。
2. 保存用户上传的原始图片到 `pic/`。
3. 保存编辑后的拼豆网格到 `results/`，并支持之后重新加载回主编辑页面继续编辑。
4. 导出 MARD 品牌下不同色板范围的豆子统计 CSV。
5. 用户可以创建自己的豆仓，记录某个品牌、某个色板、每个颜色各有多少颗豆。
6. 用户可以在豆仓里加载已保存的拼豆图纸，计算库存是否足够。
7. 拼豆计划支持状态：草稿、进行中、已完成。只有状态变为“已完成”时才扣除豆仓库存。

## 本地版架构

本项目不部署到 Vercel，只在本地运行。因此可以使用：

- Next.js 前端页面
- Next.js API Route
- Node.js 文件系统 API

所有需要读写本地磁盘的动作都通过 API Route 完成。

```txt
perler-beads/
  src/
    data/
      色号对应表.csv
      mardPaletteSets.csv

  pic/
    用户上传的原始图片

  results/
    projects/
      每个项目一个文件夹
      project.json
      patterns/
        项目内图纸 .grid.json
    可选导出 PNG

  warehouse/
    inventory.json
    plans.json
```

`src/data/色号对应表.csv` 保存原始色号对应表。当前运行代码仍使用 `src/app/colorSystemMapping.json` 作为应用内颜色映射数据，后续可以增加脚本从 CSV 生成 JSON，避免手动同步。

`src/data/mardPaletteSets.csv` 保存 MARD 各色板方案包含的色号集合。第一版只统一支持 `96`、`144`、`291`。

## 页面入口

第一版主页面保留三个主要入口按钮：

1. 加载豆仓 / Load Warehouse
   - 进入豆仓管理页面。
   - 用户可以查看、切换、补货、维护库存。

2. 加载图纸 / Load Pattern Sheet
   - 加载已经带网格、颜色和数字的拼豆图纸。
   - 进入“图纸分析 / Pattern Analysis”流程。

3. 加载项目 / Load Project
   - 打开项目文件夹列表。
   - 用户可以新建项目，或点进已有项目工作台。

主编辑页面 `/` 继续作为图片上传、分析、编辑页面，并保留“保存项目 / Save Project”按钮。用户编辑完成后手动点击保存。

豆仓页面 `/warehouse` 用于创建和管理豆仓、管理库存、创建拼豆计划。后续页面都需要提供“返回主页 / Back Home”入口。

暂不单独创建 `/plans` 页面。拼豆计划先放在豆仓页面内。

### 加载项目页面设计

加载项目页面展示项目文件夹列表。每个项目是一个独立文件夹，而不是单个 `.grid.json` 文件。

项目目录建议：

```txt
results/projects/
  2026-08-13_cat/
    project.json
    patterns/
      cat.grid.json
      cat_c2.grid.json
```

说明：`patterns/` 用于保存项目内图纸文件，但“加入项目/加入计划”不等于永远无条件复制一份。是否建立副本由图纸当前引用状态和计划状态决定。

`project.json` 建议结构：

```ts
{
  schemaVersion: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  warehouseId: string;
  warehouseName: string;
  warehouseLockedAt: string;
  status: "draft" | "in_progress" | "completed";
  patterns: [
    {
      id: string;
      name: string;
      fileName: string;
      thumbnailPath?: string;
      gridDimensions: { N: number; M: number };
      totalBeadCount: number;
      status: "draft" | "in_progress" | "completed";
      addedToPlanAt?: string;
      completedAt?: string;
      inventoryDeductedAt?: string;
    }
  ];
  summary: {
    totalNeeded: number;
    totalOwned: number;
    totalMissing: number;
    colorsNeeded: number;
  };
}
```

加载项目页面包含：

1. 顶部：返回主页按钮。
2. 项目列表：展示已有项目文件夹。
3. 新建项目按钮。
4. 点击已有项目：进入该项目页面。

新建项目时需要询问：

1. 项目名字。
2. 使用哪个豆仓。

建立完成后自动进入项目页面。项目一旦建立完成，绑定豆仓不允许更换。如果用户需要使用另一个豆仓，需要新建项目。

### 项目页面设计

项目页面是当前项目的计划工作台。

页面包含：

1. 顶部：返回加载项目页面、返回主页。
2. 项目信息：项目名、绑定豆仓、当前计划状态、总图纸数。
3. `+` 添加按钮：
   - 点击后可以加载图纸。
   - 图纸可以来自已经保存的 `.grid.json`，也可以来自加载图纸/解析流程完成后的结果。
4. 图纸缩略图列表：
   - 加载图纸后自动显示已经编辑好的图纸缩小预览。
   - 每张图纸显示名称、尺寸、总豆数、状态。
   - 图纸按状态分成三个区域显示：
     - `draft`：图纸已加入项目计划，但还没开始拼，例如图纸 A/B/C。
     - `in_progress`：拼图中。
     - `completed`：图纸已完成，库存已扣除，transaction log 已写入。
5. 用户选择需要的图纸后，可以把图纸从 `draft` 改为 `in_progress`。
6. 当前计划需求：
   - 显示本项目当前计划需要的豆子颜色和数量。
   - 可以切换到 `Missing` 视图。
7. `Missing` 视图：
   - 显示需要补货的颜色和数量。
   - 按缺少数量从高到低排序。

点击某张图纸可以进入图纸操作面板，支持：

1. 查看图纸详情。
2. 开始拼图。
3. 完成图纸。
4. 撤销完成。

完成图纸会扣除绑定豆仓库存，必须二次确认。

确认弹窗显示：

1. 图纸名。
2. 扣除总数。
3. 涉及颜色数。
4. 是否会产生负库存。
5. 将写入 transaction log。

如果会产生负库存，不能完成图纸，需要提示用户先补货。

已完成图纸允许“撤销完成”。撤销完成用于用户误点完成后反向恢复库存。

撤销完成规则：

1. 只对 `completed` 图纸显示“撤销完成”。
2. 点击后必须二次确认。
3. 系统把该图纸完成时扣除的数量加回绑定豆仓库存。
4. 图纸状态从 `completed` 改回 `in_progress`。
5. 写入一条反向 transaction log，类型为 `restore_for_uncompleted_plan`，并关联原扣库存 transaction。
6. 撤销完成后自动重新计算项目 `summary` 和 `Missing` 视图。

### 图纸加入项目规则

图纸加入项目或当前计划时，不能简单理解为“永远复制一份新图纸”。需要按实际场景处理：

1. 如果图纸还没有被计划使用，可以直接作为当前项目图纸使用。
2. 如果图纸已经被未完成计划使用，用户编辑或再次使用时需要提示：
   - 建立图纸副本并重新命名。
   - 直接更新原图纸，并同步更新引用该图纸的未完成计划。
3. 如果图纸已经被已完成计划使用，不允许直接修改原图纸；必须建立图纸副本，让用户重新命名。
4. 如果同一张图要做多份，必须告知用户会创建重复图纸，命名为 `c2`、`c3` 等，每张图纸生成独立 `id`。
5. 项目页面里显示的是当前项目可用的图纸条目；每个条目必须能追踪到自己的 `.grid.json`、`id`、状态和库存扣除记录。

### 项目内计划计算

项目页面中的当前计划统计该项目中所有未完成图纸，也就是 `draft` 和 `in_progress` 图纸。

计算规则：

1. 遍历当前项目中 `status === "draft"` 或 `status === "in_progress"` 的图纸。
2. 读取每张图纸 `.grid.json` 里的 `colorCounts`。
3. 按 hex/colorKey 汇总成本项目总需求。
4. 用项目绑定豆仓的库存计算 `owned`、`missing`、`remainingAfterProject`。
5. `Missing` 视图只展示 `missing > 0` 的颜色。
6. 已经完成并扣过库存的图纸，不再计入当前未完成需求；它的扣除依据保留在 transaction log。
7. 手动补货成功后，如果当前打开的项目绑定了该豆仓，必须自动重新计算项目 `summary` 和 `Missing` 视图。

点击“完成图纸”时，只扣除该图纸自己的 `colorCounts`，不是扣除整个项目总需求。

项目图纸状态规则：

1. `draft`：图纸已加入项目计划，但还没开始拼。
2. `in_progress`：拼图中。
3. `completed`：图纸已经完成，库存已经扣除，并且 transaction log 已写入。

### 豆仓页面设计

`/warehouse` 页面包含：

1. 顶部：返回主页按钮。
2. 我的豆仓列表 / My Warehouses：
   - 展示所有已创建豆仓。
   - 用户可以切换不同豆仓。
   - 每个豆仓显示名称、品牌、色系/色板，例如 `MARD 96`、`MARD 144`、`MARD 291`。
   - 每个豆仓显示健康度 / health，用于概览库存状态。
3. 当前豆仓详情：
   - 显示当前豆仓的品牌、色系、颜色数量、总库存颗数、健康度。
   - 下方列表展示每个颜色、色号、色块、当前有多少颗。
4. 右上角：手动补货按钮。
5. 拼豆图纸 / Bead Patterns 区域：
   - 加载已保存 `.grid.json` 图纸。
   - 使用当前豆仓计算缺豆。
   - 创建或查看拼豆计划。

健康度第一版按当前计划颜色的 missing 情况计算：

1. 绿色：计划颜色中没有 missing。
2. 黄色：计划颜色中有 missing，但缺少颜色数 <= 当前计划颜色总数的 50%。
3. 红色：缺少颜色数 > 当前计划颜色总数的 50%，或存在库存为 0 的计划颜色。

如果当前没有计划图纸，健康度显示为未开始 / no active plan。

### 手动补货页面

从豆仓页面点击“手动补货”进入补货页面或弹窗。

补货页面包含：

1. 顶部：返回豆仓按钮。
2. 目标品牌 / target brand：
   - 第一版默认 `MARD`。
   - 后续可以扩展其他品牌。
3. 手动捕获/粘贴文本输入区：
   - 默认文本格式为 `颜色-多少颗`。
   - 解析时需要支持常见粘贴格式。
   - 每行一条，例如：

```txt
T1-500
H7-300
R11-100
T1 500
T1,500
T1：500
T1-500颗
```

4. 解析预览：
   - parse string 后先显示给用户确认，不能直接导入。
   - 显示识别出的色号、数量、是否存在于目标品牌色系。
   - 无法识别的行需要提示用户修改。
   - 同一色号出现多行时，需要合并数量，并在预览中显示合并结果。
5. 底部：导入到豆仓按钮。

用户确认解析预览后，才能点击导入到豆仓。导入到豆仓时，为每个颜色增加库存，并写入 transaction log，`note` 可记录为“手动补货导入”或用户输入的说明。

## 第一阶段：保存拼豆项目

### 保存时机

用户编辑完成后，手动点击：

```txt
保存项目 / Save Project
```

不做自动保存，避免频繁写文件和产生过多中间结果。

### 项目命名

保存时项目名来源：

1. 用户输入项目名。
2. 如果用户不输入，默认使用上传图片的文件名。

保存时仍然加时间戳，避免重名。

示例：

```txt
2026-08-13_143012_cat.grid.json
```

### 保存和另存为

项目保存需要区分“保存”和“另存为”：

1. 新项目第一次保存：创建新的 `.grid.json`，生成新的 `id`。
2. 已加载项目点击保存：覆盖当前项目文件，保留原 `id`，更新 `updatedAt`。
3. 已加载项目点击另存为：创建新的 `.grid.json`，生成新的 `id`，用户需要重新命名。
4. 如果当前项目已经被已完成计划引用，不能直接覆盖原项目，只能另存为副本。
5. 如果当前项目被未完成计划引用，保存前按“图纸引用和重复计划”规则询问用户是建立副本还是同步更新未完成计划。

### 原图保存

原图保存用户上传的原始文件，尽量保持原始格式：

```txt
pic/
  2026-08-13_143012_cat_original.png
  2026-08-13_143012_dog_original.jpg
```

### 拼豆网格保存

编辑后的拼豆图保存为：

```txt
results/project-name.grid.json
```

该文件必须支持之后重新加载回主编辑页面继续编辑。

建议结构：

```ts
{
  schemaVersion: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  originalFileName: string;
  originalImagePath: string;
  selectedColorSystem: "MARD";
  brand: "MARD";
  paletteName: "96" | "144" | "291";
  gridDimensions: { N: number; M: number };
  mappedPixelData: MappedPixel[][];
  colorCounts: {
    [hex: string]: {
      count: number;
      color: string;
      colorKey: string;
      isExtraColor?: boolean;
      recommendedColor?: string;
      recommendedColorKey?: string;
    };
  };
  totalBeadCount: number;
}
```

关键词：

- `mappedPixelData`: 映射后的像素数据 / mapped pixel data
- `MappedPixel[][]`: 二维拼豆网格 / 2D bead grid
- `gridDimensions`: 网格尺寸 / grid dimensions
- `colorCounts`: 豆数统计 section / bead count section，用于计划计算和 CSV 导出
- `totalBeadCount`: 总拼豆数量 / total bead count
- `schemaVersion`: `.grid.json` 文件结构版本，用于后续兼容旧项目

### JSON 和 CSV 的关系

项目保存时只保存一份 `.grid.json`。`.grid.json` 是项目的唯一数据来源，里面的 `mappedPixelData` 和 `colorCounts` 是之后重新编辑、计划计算、库存扣减的依据。

CSV 不作为项目保存文件，不参与后续计算。用户需要 Excel 表时，再从当前 `.grid.json` 的 `colorCounts` 临时导出 CSV。

用户主动导出 CSV 时，下载文件名也需要安全化，不能包含 Windows 非法文件名字符。建议格式：

```txt
2026-08-13_cat_MARD-96_bead-count.csv
```

### 项目列表读取

项目列表只在用户点击“加载项目 / Load Project”或打开项目列表弹窗时读取。

列表阶段只扫描 `results/projects/` 下的项目文件夹，并读取每个项目文件夹里的 `project.json` 摘要字段，不读取各图纸的完整 `mappedPixelData`：

```ts
{
  id: string;
  name: string;
  updatedAt: string;
  warehouseId: string;
  warehouseName: string;
  patternCount: number;
  totalBeadCount: number;
  totalMissing: number;
  thumbnailPath?: string;
}
```

用户点进某个项目后，读取该项目的 `project.json` 和图纸摘要。用户点击具体图纸或进入编辑时，才读取对应完整 `.grid.json`。

### 大图纸性能

最大图纸可能达到 `104 x 104 = 10816` 个格子。`.grid.json` 需要只保存重新编辑、计划计算和恢复项目所必需的数据。

规则：

1. 不把临时 UI 状态、弹窗状态、hover/selection 状态保存进 `.grid.json`。
2. 不保存每个格子的裁切小图、预览图或可重新计算的大型冗余数据。
3. `colorCounts` 保存为统计 section，避免计划页面为了算豆数必须遍历整张大图。
4. 项目列表阶段只读摘要字段，避免一次加载多个大图纸的完整 `mappedPixelData`。

## 第二阶段：MARD 色板统计 CSV

CSV 第一版只统计 MARD 品牌色系，但只作为导出报表，不作为权威数据。

需要支持 MARD 的：

- `96`
- `144`
- `291`

用户主动导出时，根据当前项目 `.grid.json` 里的 `colorCounts` 和当前色板生成对应 CSV。

示例：

```csv
hex,brand,paletteName,color_key,count
#000000,MARD,144,H1,88
#FFFFFF,MARD,144,T1,120
```

说明：

- `hex` 是系统内部稳定颜色值。
- `brand` 第一版固定为 `MARD`。
- `paletteName` 是 `96`、`144` 或 `291`。
- `color_key` 是 MARD 色号。
- `count` 是该图纸需要的豆子数量。

暂不做真正 `.xlsx` 文件。CSV 可以直接用 Excel 打开。

## 第三阶段：创建豆仓

豆仓由用户创建。一个豆仓包含：

1. 豆仓名称。
2. 品牌，例如 `MARD`、`COCO`。
3. 色板颜色数量，例如 `96`、`144`、`291`。
4. 每个颜色有多少颗豆。

建议保存到：

```txt
warehouse/inventory.json
```

建议结构：

```ts
{
  warehouses: [
    {
      id: string;
      name: string;
      brand: "MARD" | "COCO" | string;
      paletteName: "96" | "144" | "291" | string;
      createdAt: string;
      updatedAt: string;
      items: [
        {
          hex: string;
          colorKey: string;
          ownedCount: number;
        }
      ]
    }
  ]
}
```

第一版不需要知道“买了几套”自动展开库存。用户直接设置每个颜色多少颗。

后续如果有套装规格数据，再增加：

```txt
warehouse/sets.json
```

用于描述“某品牌某套装每个颜色默认多少颗”。

## 第四阶段：豆仓内拼豆图纸与计划

在 `/warehouse` 页面内增加：

```txt
拼豆图纸 / Bead Patterns
```

用户可以：

1. 选择一个已保存的 `.grid.json` 图纸。
2. 选择使用哪个豆仓计算。
3. 创建拼豆计划。
4. 查看每个颜色需要多少、库存多少、缺多少、完成后剩多少。
5. 修改计划状态。

### 计划状态

拼豆计划支持：

```ts
type PlanStatus = "draft" | "in_progress" | "completed";
```

中文显示：

- `draft`: 草稿
- `in_progress`: 进行中
- `completed`: 已完成

规则：

1. 草稿和进行中只计算缺豆，不改变库存。
2. 只有计划状态改为已完成时，才扣除豆仓库存。
3. 已完成计划需要记录是否已经扣过库存，避免重复扣除。
4. 每一次库存扣除、库存增加、完成撤销都必须追加库存交易日志，保留完整计算过程。
5. 如果已完成计划被撤销为草稿或进行中，需要生成一条反向库存交易记录，把该计划扣除过的数量加回库存。
6. 库存日志是账本依据，不允许覆盖旧记录，只能追加新记录。

建议结构：

```ts
{
  plans: [
    {
      id: string;
      warehouseId: string;
      projectId: string;
      projectName: string;
      status: "draft" | "in_progress" | "completed";
      createdAt: string;
      updatedAt: string;
      completedAt?: string;
      inventoryDeductedAt?: string;
      inventoryRestoredAt?: string;
      summary: {
        totalNeeded: number;
        totalOwned: number;
        totalMissing: number;
      };
      items: [
        {
          hex: string;
          colorKey: string;
          needed: number;
          owned: number;
          missing: number;
          remainingAfterProject: number;
        }
      ]
    }
  ]
}
```

### 图纸引用和重复计划

一个计划引用某个 `.grid.json` 后，如果用户重新加载并修改该图纸，需要按计划状态处理：

1. 如果引用该图纸的计划还没有完成，保存图纸时提醒用户选择：
   - 建立图纸副本并重新命名。
   - 直接更新原图纸，并同步更新已有未完成计划使用的图纸数据。
2. 如果引用该图纸的计划已经完成，保存时必须提醒用户建立图纸副本并重新命名，不允许静默修改已完成计划引用的原图纸。
3. 未完成计划同步更新图纸后，需要重新计算 `summary` 和 `items`。
4. 已完成计划保留完成时的计算依据和库存交易日志，不随之后的图纸副本变化。

同一张图如果要做多份，不直接复用同一个 `projectId` 创建多个独立计划。系统需要明确告知用户会创建重复图纸副本，并按 `c2`、`c3` 这类后缀命名。每个副本都生成独立 `id`，之后按独立图纸和独立计划计算库存。

计算公式：

```ts
needed = project.colorCounts[hex].count
owned = warehouse.items[hex].ownedCount
missing = Math.max(0, needed - owned)
remainingAfterProject = owned - needed
```

导出 CSV 示例：

```csv
hex,brand,paletteName,color_key,needed,owned,missing,remaining_after_project
#000000,MARD,144,H1,88,50,38,-38
#FFFFFF,MARD,144,T1,120,200,0,80
```

## 颜色方案切换：MARD 96 / 144 / 291

当前主编辑页面使用 MARD 全量 `291` 色作为主要颜色方案。后续需要增加颜色方案选择：

```ts
type MardPaletteName = "96" | "144" | "291";
```

页面上允许用户选择：

- `MARD 96`
- `MARD 144`
- `MARD 291`

`MARD 96` 和 `MARD 144` 使用 `src/data/mardPaletteSets.csv` 中的色号集合。`MARD 291` 使用 `src/app/colorSystemMapping.json` 中的 MARD 全量颜色集合。

### 颜色映射校验

第一版颜色统计、库存和计划仍然可以用 `hex` 作为主要统计 key。为了避免同一品牌内出现重复 hex 或映射异常，需要建立 validation test。

规则：

1. 读取 `src/app/colorSystemMapping.json` 时，校验 MARD 色系内不存在重复 hex 引起的歧义。
2. 读取 `src/data/mardPaletteSets.csv` 时，校验 `96`、`144` 中的色号都能在 MARD 291 全色系中找到。
3. 如果发现重复 hex、缺失色号、非法 hex、同一色号映射到多个 hex，测试直接报错。
4. validation test 作为后续保存项目、创建豆仓、切换色板前的基础保障。

### 切换默认行为

当用户切换颜色方案时，需要检查当前 `mappedPixelData` 中每个颜色是否属于目标颜色方案。

如果某个颜色不在目标颜色方案中，默认行为是：

1. 标记该颜色为额外颜色 / extra color。
2. 自动寻找目标颜色方案中最近的颜色 / nearest in-palette color。
3. 首次切换到某个目标方案时，先弹出确认列表，用户确认后才批量替换。
4. 第二次及之后切换到同一个目标方案时，不再强制确认，可以直接按上次选择的规则处理。
5. 在 UI 中展示“这些颜色不在当前方案中”。

最近颜色匹配继续使用当前项目里的颜色距离逻辑：

- `colorDistance`
- `findClosestPaletteColor`

### 保留原始颜色

用户可以选择保留某些不在目标方案里的原始颜色。保留后，该格子继续显示原始颜色，但需要记录它是额外颜色：

```ts
interface MappedPixel {
  key: string;
  color: string;
  isExternal?: boolean;
  isExtraColor?: boolean;
  targetPaletteReplacement?: {
    key: string;
    color: string;
  };
}
```

说明：

- `isExtraColor`: 当前格子颜色不属于目标颜色方案。
- `targetPaletteReplacement`: 系统推荐的目标方案内最近替代色。
- 如果用户接受自动替换，则格子颜色改成 `targetPaletteReplacement`，`isExtraColor` 可以为 `false` 或移除。
- 如果用户选择保留原始颜色，则格子颜色保持不变，`isExtraColor` 为 `true`。
- 保留原始颜色第一版按颜色整体处理，不按区域处理。例如 `R11` 保留时，所有 `R11` 格子都保留。
- 后续可以允许用户用刷子 / brush 手动改变局部区域颜色。

### 颜色方案和自定义色板

颜色方案选择包括：

- `MARD 96`
- `MARD 144`
- `MARD 291`
- `自定义 / Custom`

规则：

1. 选择 `MARD 96 / 144 / 291` 时，自动更新当前 `activeBeadPalette`。
2. 用户手动修改色板后，当前方案显示为 `自定义 / Custom`。
3. 这里的自定义色板优先理解为用户豆仓色板方案，也就是用户实际拥有的 MARD 颜色集合。
4. 豆仓本质上是 MARD 291 全色系的一个子集，加上用户为了某张图纸额外购买/额外保留的颜色。
5. 自定义色板中的每个颜色都必须来自 MARD 291 全色系，不允许录入 MARD 291 之外的颜色。

### UI 展示

切换颜色方案后，页面需要显示一组额外颜色提示：

```txt
以下颜色不在 MARD 96 中
```

每个额外颜色展示：

- 原始色号 / original color key
- 原始颜色 / original color
- 使用数量 / count
- 豆仓内包含颜色 / colors available in warehouse
- 推荐颜色组 / recommended colors
- 操作：使用豆仓内颜色
- 操作：使用推荐颜色
- 操作：保留原始颜色

页面色号组里必须分成两组颜色分类：

1. 豆仓内包含颜色：当前豆仓实际拥有的 MARD 291 色系颜色。如果 extra color 可以映射到豆仓内已有颜色，优先放在这一组供用户选择。
2. 推荐颜色组：系统根据颜色距离、识别结果或邻近颜色推荐的 MARD 291 色系颜色。推荐颜色不一定在当前豆仓内。

可以先做成列表或弹窗，第一版不必做复杂批量编辑。

### 导出额外颜色

导出 CSV 时增加额外颜色字段：

```csv
hex,brand,paletteName,color_key,count,is_extra_color,recommended_color_key,recommended_hex
#FFEBFB,MARD,96,R11,12,true,R10,#FFDB4C
#000000,MARD,96,H7,88,false,,
```

字段说明：

- `is_extra_color`: 是否为目标方案外颜色。
- `recommended_color_key`: 推荐替代色号。
- `recommended_hex`: 推荐替代色 hex。
- CSV 永远按最终当前网格统计。
- 自动替换后的格子算推荐色。
- 用户选择保留原始色的格子算 extra color。

保存 `.grid.json` 时也要保留 `isExtraColor` 和 `targetPaletteReplacement`，确保重新加载项目后仍能知道哪些颜色是额外颜色。

### 计划计算中的额外颜色

豆仓计划计算时，如果图纸包含额外颜色：

1. 如果豆仓里有该 extra color，则按真实颜色计算库存。
2. 如果豆仓里没有该 extra color，则显示缺少该额外颜色。
3. 豆仓页面需要显示“额外购买颜色 / extra purchase colors”，提示用户这些颜色不属于当前基础方案但需要额外准备。
4. 不应静默把 extra color 当作目标方案内推荐色，除非用户已经在编辑页确认替换。

## 已确认规则补充

### 加载图纸与图纸分析

主页面需要同时支持两种输入：

1. 加载普通图片 / load image
   - 走当前图片像素化流程。
2. 加载已有拼豆图纸 / load bead pattern sheet
   - 图纸本身已经带网格、颜色和数字。
   - 进入“图纸分析 / Pattern Analysis”流程。

如果用户加载的是图纸而不是普通图片，进入加载图纸页面。顶部当前已有“优化编辑 / 预览 / 拼豆”时，第一版先隐藏“拼豆”，并调整为：

```txt
解析 / Parse
优化 / Optimize
编辑 / Edit
```

规则：

1. `解析` 页面用于把图纸用 Canvas/OpenCV 方式解析成结构化格子数据。
2. `优化` 页面用于后续调整解析结果、颜色方案和推荐替换。
3. `编辑` 页面用于进入当前拼豆网格编辑体验。
4. `拼豆` 入口第一版先隐藏，不在加载图纸流程中展示。

### 图纸分析目标

图纸分析用于把一张已经带网格和数字的图纸转换成当前系统可编辑的 `MappedPixel[][]`。

核心步骤：

1. 读取图纸网格 / detect grid。
2. 对每个格子做 Canvas/OpenCV 裁切和模板匹配 / cell crop and template matching。
3. 把解析出的数字或色号映射到 MARD 291 色系中的颜色。
4. 为每个格子记录识别置信度 / confidence。
5. 为每个格子记录不确定性 / uncertainty。
6. 用户校验识别结果。
7. 用户点击“分析完成 / Finish Analysis”后，进入当前预览/编辑页面。

建议中间数据结构：

```ts
interface AnalyzedPatternCell {
  row: number;
  col: number;
  detectedText: string;
  detectedColorKey?: string;
  detectedHex?: string;
  recognitionMethod: "template_matching" | "manual" | "ocr_fallback";
  confidence: number;
  uncertainty: number;
  status: "pending" | "confirmed" | "changed" | "transparent";
  recommendedColorKeys?: string[];
}
```

分析完成后转换为：

```ts
MappedPixel[][]
```

### 图纸解析页面

上传图纸后，先进入图纸解析页面。解析页面负责执行 Canvas/OpenCV 网格检测、格子裁切、色号/数字模板匹配和透明格判断。

建议路由：

```txt
/analysis
```

加载图纸页面顶部入口：

```txt
解析 / 优化 / 编辑
```

流程：

```txt
加载图纸 -> 解析 -> 分组校验 -> 优化 -> 编辑
```

页面展示：

1. 分析后的图纸图案。
2. 下方显示本次图纸需要用到的色号列表。
3. 显示总颗数。
4. 每个色号是一个按钮。

色号按钮示例：

```txt
H7 88颗
R11 12颗
T1 120颗
透明 43格
```

点击某个色号按钮后，页面加载该色号分组下所有 CV 解析出的格子。

### 分组格子校验

某个色号分组页面中，所有格子按 `uncertainty` 从高到低排序。

也就是越不准确、越需要人工判断的格子排在越前面。

每个格子需要展示：

- 格子坐标 / row col
- 原图裁切小图 / cell crop
- Canvas/OpenCV 解析结果 / detected text
- 当前归属颜色 / current group color
- confidence
- uncertainty

用户可以判断这个格子里的数字是不是和当前色号一致。

如果不一致，用户可以选择该格子，然后执行：

1. 改分组 / move to group
2. 透明 / transparent
3. 换新颜色 / change color

### 改分组

点击“改分组 / move to group”时，显示本次分析识别出的所有颜色。

用户选择其中一个颜色后，该格子移动到对应颜色分组。

### 透明

点击“透明 / transparent”时，该格子移动到透明组。

转换到 `MappedPixel` 时：

```ts
{
  key: "ERASE",
  color: "#FFFFFF",
  isExternal: true
}
```

透明格沿用当前 repo 的定义：`TRANSPARENT_KEY = "ERASE"`，并且 `isExternal: true`。`#FFFFFF` 仍然可以是正常白色豆，例如 MARD `T1`，所以统计和导出时不能只靠 hex 判断透明。

规则：

1. 透明格判断条件以 `cell.isExternal === true` 或 `cell.key === "ERASE"` 为准。
2. 颜色统计、豆仓计划和扣库存都排除透明格。
3. 白色豆必须保留正常色号，例如 `T1`，并且 `isExternal` 不能为 `true`。
4. 保存 `.grid.json` 时保留 `key: "ERASE"` 和 `isExternal: true`，确保重新加载后透明格不会变成白色豆。

### 换新颜色

点击“换新颜色 / change color”时，用户可以：

1. 从任意 MARD 291 颜色中选择。
2. 从系统推荐的几个接近颜色中选择。

系统推荐颜色可以基于：

- 模板匹配 detected text 的近似匹配。
- 当前格子背景颜色和 MARD 291 的颜色距离。
- 周围邻近格子的颜色。

第一版可以先做：

```txt
推荐颜色 = 当前格子背景色最接近的若干 MARD 291 颜色
```

### 图纸分析识别技术路线

第一版使用 Canvas/OpenCV 优先，不把通用 OCR 作为主路径。

原因：

- 最大板子可能达到 `104 x 104 = 10816` 个格子。
- 每个格子只需要识别短色号，例如 `H7`、`F22`、`E8`。
- 图纸字体和格子结构相对统一，更适合模板匹配。
- 通用 OCR 对 1 万多个小格子逐个识别会更慢且不稳定。

MVP 识别流程：

```txt
Canvas/OpenCV 检测网格
-> 用户必要时拖动四角/边界校准
-> 裁切每个格子
-> 先用空白/背景色判断透明
-> 对非透明格做模板匹配识别 MARD 色号
-> 计算 confidence 和 uncertainty
-> 低置信度格子进入人工校验队列
```

OCR 只作为后续兜底方案：

```txt
template_matching -> manual correction -> optional ocr_fallback
```

### 分析完成

用户检查完每个分组后，点击：

```txt
分析完成 / Finish Analysis
```

系统将分析结果转换为 `mappedPixelData`、`gridDimensions`、`colorCounts` 和 `totalBeadCount`，并进入当前预览/编辑页面。

如果图纸分析结果包含未确认格子，第一版可以允许继续，但需要提示：

```txt
仍有未确认格子，是否继续？
```

### 图纸分析导出和保存

从图纸分析得到的项目保存 `.grid.json` 时，需要记录来源：

```ts
sourceType: "analyzed_pattern_sheet";
analysisMetadata: {
  originalPatternImagePath: string;
  analyzedAt: string;
  ocrEngine?: string;
  unconfirmedCellCount: number;
}
```

这样后续可以知道该项目不是从普通图片像素化生成，而是从已有图纸反向解析得到。

### 裁切小图保存策略

图纸分析编辑过程中可以渲染每个格子的裁切小图 / cell crop preview，帮助用户判断 OCR 是否正确。

规则：

1. 裁切小图只在分析/编辑页面临时渲染。
2. 分析完成后不保存裁切小图。
3. `.grid.json` 只保存解析结果、最终网格和必要 metadata，不保存每个格子的图片文件。

### 首次切换确认

颜色方案切换采用“首次确认、之后复用”的规则：

1. 用户第一次切换到某个目标方案时，先弹出确认列表。
2. 确认列表展示所有目标方案外颜色、使用数量，并在每个色号组内展示“豆仓内包含颜色”和“推荐颜色组”。
3. 用户确认后才批量替换。
4. 用户必须在色号组中选择处理方式：使用豆仓内颜色、使用推荐颜色、保留原始颜色。
5. 第二次及之后切换到同一个目标方案时，不再强制确认，可以直接使用上次选择规则。
6. 每一次颜色方案切换造成的批量替换，都必须作为单个 undo 操作入栈，用户可以一次撤销整次切换。

### 保留粒度

保留原始颜色第一版按颜色整体保留，不按区域保留。

例如 `R11` 不在 `MARD 96` 中，如果用户选择保留 `R11`，则当前图里所有 `R11` 格子都保留为 extra color。

后续局部差异通过刷子 / brush 手动改区域颜色解决。

### 豆仓和自定义色板

第一版豆仓以 MARD 为主。

豆仓本质上是用户在 `MARD 291` 全色系里拥有的颜色子集，并且可以因为某张图纸需要而加入额外购买颜色。

规则：

1. 豆仓里的颜色必须来自 `MARD 291` 全色系。
2. 自定义色板优先理解为用户豆仓色板，也就是用户实际拥有的 MARD 颜色集合。
3. 如果用户在 `MARD 96` 图纸里保留了 `R11` 这类方案外颜色，豆仓页面需要显示为“额外购买颜色 / extra purchase color”。
4. 额外购买颜色可以加入豆仓，但仍必须来自 `MARD 291`。
5. 用户需要先创建并命名豆仓，例如 `amazon-md-96`。
6. 用户命名的豆仓自定义色板是首选颜色方案，标准 `MARD 96 / 144 / 291` 是次选方案。
7. 如果加载的图纸超出当前豆仓自定义色板方案，系统自动切换到 `MARD 291` 全色系，并展示超出豆仓的颜色。
8. 创建 `MARD 96` 豆仓时，默认生成 96 个库存项，每个颜色默认 `ownedCount = 500`。

建议库存项增加：

```ts
{
  hex: string;
  colorKey: string;
  ownedCount: number;
  isExtraPurchase?: boolean;
}
```

### 扣库存日志

计划状态从 `in_progress` 改为 `completed` 时才扣库存。

每次扣库存、增加库存、撤销完成返还库存都必须生成库存变化记录 / inventory transaction log，并能导出 CSV，作为之后核算依据：

```txt
原有库存 - 某张图纸使用量 = 当前库存
原有库存 + 撤销返还数量 = 当前库存
```

建议新增：

```txt
warehouse/inventory-transactions.json
warehouse/inventory-transactions.csv
```

库存变化记录结构：

```ts
{
  id: string;
  warehouseId: string;
  planId: string;
  projectId: string;
  projectName: string;
  createdAt: string;
  type:
    | "deduct_for_completed_plan"
    | "restore_for_uncompleted_plan"
    | "manual_inventory_increase"
    | "manual_inventory_adjustment";
  relatedTransactionId?: string;
  note?: string;
  items: [
    {
      hex: string;
      colorKey: string;
      beforeCount: number;
      delta: number;
      afterCount: number;
    }
  ];
}
```

规则：

1. `deduct_for_completed_plan` 用于计划完成扣库存，`delta` 为负数。
2. `restore_for_uncompleted_plan` 用于撤销已完成计划，`delta` 为正数，并通过 `relatedTransactionId` 指向原扣库存记录。
3. 手动增加或调整库存也必须写入 transaction log，并允许用户填写 `note` 说明原因，例如“新买一包 T1”。
4. transaction log 永远追加，不覆盖旧记录。

### 本地 JSON 写入一致性

库存相关写入需要尽量保持原子性，避免 inventory、plans 和 transaction log 不一致。

必须执行流程：

```txt
读取 inventory/plans/transactions
-> 校验计划状态、库存是否足够、是否已经扣过或返还过
-> 在内存中计算新的 transaction、inventory、plans
-> 写入临时文件
-> 校验临时文件 JSON 可读
-> 用 rename 替换正式文件
```

规则：

1. 任一步失败都不更新正式文件。
2. 完成计划时必须先校验所有颜色不会变成负库存。
3. transaction、inventory、plans 三类文件需要按同一批计算结果生成，不能分散使用不同时间点的数据。
4. 如果本地文件已经损坏或无法解析，API 需要阻止写入并提示用户先备份/修复。
5. 不允许边计算边直接改正式 JSON 文件。

### CSV 统计口径

CSV 永远按最终当前网格统计。

规则：

1. 自动替换后的格子算推荐色。
2. 用户选择保留原始色的格子算 extra color。
3. 如果同一个原始颜色一部分被替换、一部分被用户后续用刷子改成别的颜色，则按最终网格实际颜色分别统计。

### 确认列表默认选项

颜色方案切换确认列表中，每个 extra color 默认优先选择“豆仓内包含颜色”里最接近的颜色。如果当前没有绑定豆仓，或者豆仓内没有可用近似色，则默认选择“推荐颜色组”里的最近颜色。

用户可以改成：

1. 保留原始色。
2. 使用豆仓内包含颜色。
3. 使用推荐颜色组中的颜色。
4. 自选其他任意 MARD 291 色系内颜色。

自选颜色必须来自 `MARD 291`，不允许选择 MARD 291 之外的颜色。

### 确认历史保存

保存项目时，需要把颜色方案确认历史保存到 `.grid.json`：

```ts
paletteDecisionHistory: {
  "MARD:96": {
    R11: {
      action: "keep_original";
      originalColorKey: "R11";
      originalHex: "#FFEBFB";
      count: 12;
    },
    F22: {
      action: "use_warehouse_color";
      originalColorKey: "F22";
      originalHex: "#AABBCC";
      selectedColorKey: "F20";
      selectedHex: "#A1B2C3";
      selectedGroup: "warehouse";
      count: 8;
    },
    E8: {
      action: "use_recommended_color";
      originalColorKey: "E8";
      originalHex: "#DDEEFF";
      selectedColorKey: "E7";
      selectedHex: "#D0E0F0";
      selectedGroup: "recommended";
      count: 5;
    }
  }
}
```

重新加载项目后，同一个项目对同一个目标方案不再重复弹确认，并按每个色号保存过的 `action`、`selectedGroup`、`selectedColorKey` 和 `selectedHex` 复用上次选择。

### 阻止负库存

库存不允许扣成负数。

如果计划完成时库存不足，需要阻止完成，并提示用户先补齐缺少颜色或额外购买颜色。

### 文件名安全化

保存项目和原图时，文件名需要安全化。

中文可以保留，但必须去掉或替换 Windows 非法文件名字符：

```txt
/ \ : * ? " < > |
```

### 删除规则

第一版允许真删除，不做归档/隐藏。

删除对象包括：

1. 删除项目。
2. 删除项目内图纸。
3. 删除豆仓。

规则：

1. 删除前必须二次确认。
2. 删除项目会删除该项目文件夹和其中的 `project.json`、`patterns/` 图纸文件。
3. 删除项目内图纸会删除对应 `.grid.json`，并从 `project.json.patterns` 中移除。
4. 删除豆仓前必须检查是否有项目绑定该豆仓；如果有项目绑定，不允许删除。
5. 已经写入的 transaction log 不因为删除项目或图纸而删除。
6. 删除操作必须限制在 `results/projects/` 或 `warehouse/` 允许目录内，禁止通过路径参数删除任意文件。
7. 删除失败时不能留下半更新状态；如果项目 JSON 已更新但文件删除失败，需要回滚或阻止更新。

删除相关逻辑必须建立 unit test 覆盖。

测试至少包含：

1. 删除项目只删除目标项目文件夹。
2. 删除图纸只删除目标图纸，并正确更新 `project.json`。
3. 有项目绑定的豆仓不能删除。
4. 未绑定豆仓可以删除。
5. 路径穿越参数不能删除允许目录外的文件。
6. 删除失败时不会写出不一致的 `project.json`。

### 重新加载编辑

重新加载 `.grid.json` 时：

1. 如果 `originalImagePath` 仍然存在，则恢复原图预览。
2. 如果原图丢失，也允许只加载拼豆网格继续编辑。

## API Route 草案

## 当前实现优先级

当前阶段先按下面优先级实现，不按完整前端规划一次性铺开：

1. 豆仓先做后端和脚本，不先做完整豆仓前端。
   - 首页保留“加载豆仓”按钮。
   - 第一版用脚本生成固定豆仓数据。
   - 当前默认豆仓：`豆仓1`，`MARD 96`，每个颜色 `541` 颗。
   - 生成结果写入 `warehouse/inventory.json`。
2. 优先实现加载图纸的 CV 分析流程。
   - 前端需要支持图纸解析页面。
   - 后端/工具逻辑需要能把 CV 分析结果保存为 `.grid.json`。
   - `.grid.json` 中必须包含 `mappedPixelData`、`colorCounts`、`gridDimensions`、`totalBeadCount`。
3. 项目功能当前先不做完整前端。
   - 项目先通过脚本处理。
   - 用户之后会提供项目脚本 input。
   - 脚本根据 input 生成/更新项目数据、读取图纸 JSON、计算需求和 missing。
4. 完整豆仓页面、完整项目页面、项目内图纸状态 UI 放到后续阶段。

## 已完成记录

### 2026-08-13

1. 当前优先级 1 已完成：
   - 首页保留三个入口：`加载豆仓`、`加载图纸`、`加载项目`。
   - `加载图纸` 进入 `/analysis`。
   - `加载豆仓` 进入 `/warehouse`，`加载项目` 进入 `/projects`。
   - 已用脚本生成默认豆仓：`豆仓1`、`MARD 96`、每色 `541`，写入 `warehouse/inventory.json`。

2. 当前优先级 2 已完成：
   - 新增 `/analysis` 图纸分析页面。
   - 支持上传图纸、检测网格、数字输入边界、调节点方式调整边界。
   - 支持 Canvas 采样格子背景色并匹配最近 MARD 色。
   - 支持生成 `mappedPixelData`、`colorCounts`、`gridDimensions`、`totalBeadCount`。
   - 支持按颜色组查看统计、预览切割小方块、多选颜色组并批量矫正。
   - 支持矫正目标色实时预览、整图预览缩放、显示当前可见行列范围。
   - `/analysis` 解析页已调整为 `加载图纸 -> 裁剪确认 -> 网格边界 -> 解析图纸` 的流程。
   - 图纸加载后先显示裁剪框，用户点击“确定裁剪”后再进入网格边界检测。
   - 网格检测已支持在裁剪区域内运行，并加入 Sobel/Canny 风格边缘强度 + 水平/垂直投影峰值检测，用于估算网格位置和行列数。
   - 网格边界页支持默认自动检测、手动模式、`网格 / 画布` 调整目标、上下左右微调、边界数值显示和 `Reset`。
   - 裁剪交互已改为鼠标按下记录起点、拖动生成矩形、松开确定裁剪框；框选后支持 8 个 handle 和拖动框内部整体移动。
   - 网格边界手动调整复用同一套 8 handle + 内部移动交互，控制点已放大，边线也可被选中拖动。
   - 上下左右微调按钮现在作用于当前选中的边、角或整个框。
   - 支持保存 `.grid.json`，保存内容包含后续计划计算所需字段。
   - 已新增 `src/utils/patternAnalysis.ts`、`src/app/analysis/page.tsx`、`src/app/api/palettes/mard/route.ts`、`src/app/api/projects/save/route.ts`。
   - 已修复 `/analysis` 中颜色组同步 effect 在空数组状态下重复 `setState` 导致的 `Maximum update depth exceeded`。

3. 第二阶段：MARD 色板统计 CSV 已完成第一版：
   - 新增 `scripts/export-pattern-stats-csv.js`。
   - 新增 npm script：`npm run export:pattern-stats -- --pattern <file.grid.json> [--out <stats.csv>]`。
   - CSV 输出字段：`hex,brand,paletteName,color_key,count`。
   - 脚本兼容带 UTF-8 BOM 的用户输入 JSON。

4. 第三阶段：创建豆仓已完成第一版：
   - 新增 `scripts/create-warehouse.js`。
   - 新增 npm script：`npm run create:warehouse -- --name <name> --palette 96 --count <count>`。
   - 支持生成或追加更新 `warehouse/inventory.json`。
   - 第一版限制品牌为 `MARD`，支持 `96`、`144`、`291` 等 `mardPaletteSets.csv` 中存在的方案。
   - 保留旧的 `scripts/seed-warehouse.js` 和 `npm run seed:warehouse` 作为固定默认豆仓快速入口。

5. 当前优先级 3 已完成脚本第一版：
   - 新增 `scripts/calc-project-requirements.js`。
   - 新增 npm script：`npm run calc:project -- --project-name <name> --warehouse <warehouseId> --patterns <a.grid.json,b.grid.json>`。
   - 支持读取用户 input 或命令行参数、读取 `.grid.json`、绑定豆仓库存、计算 `needed`、`owned`、`missing`、`remainingAfterProject`。
   - 输出 `results/projects/<project>/project.json` 和 `.requirements.csv`。
   - 已用 `results/patterns/2026-08-13_185017_karbi.grid.json` 建立 `卡比项目`。
   - `卡比项目` 当前只包含 `karbi` 这一张图纸，绑定 `warehouse-1 / 豆仓1`。
   - 当前计算结果：总需求 `2500`，缺豆 `340`，缺少颜色数 `2`。
   - 缺少颜色：`D16` 缺 `312`，`E12` 缺 `28`。

6. 最小前端入口已完成：
   - 新增 `/warehouse` 页面，只读展示豆仓列表、当前豆仓和颜色库存。
   - 新增 `/projects` 页面，只读展示项目列表、项目图纸、总需求和 Missing。
   - 首页 `加载豆仓` 已链接到 `/warehouse`。
   - 首页 `加载项目` 已链接到 `/projects`。
   - 完整状态流转、扣库存、撤销完成和补货编辑仍留到后续阶段。

7. 首页收尾已完成：
   - 隐藏“请作者喝杯奶茶”入口和弹窗挂载。
   - 首页品牌文案从“七卡瓦 拼豆底稿生成器”改为“个人拼豆底稿生成器”。
   - 顶部外链只保留 GitHub。
   - GitHub 链接已改为当前仓库：`https://github.com/YQZ530/fuse-beads`。

8. 验证：
   - `npx tsc --noEmit` 通过。
   - `/` 返回 200。
   - `/analysis` 返回 200。
   - `/warehouse` 返回 200。
   - `/projects` 返回 200。
   - `scripts/create-warehouse.js`、`scripts/export-pattern-stats-csv.js`、`scripts/calc-project-requirements.js` 已用临时样例验证通过。
   - 修复无限更新后重新验证 `npx tsc --noEmit`、`/analysis`、`/projects` 通过。
   - 调整 `/analysis` 裁剪和网格边界流程后重新验证 `npx tsc --noEmit`、`/analysis` 通过。
   - 改造裁剪/网格边界选中逻辑后重新验证 `npx tsc --noEmit`、`/analysis` 通过。

9. 豆仓线前端与本地 JSON 写入能力已完成第一版（工作目录：`C:\Users\z5308\Desktop\perler-beads-warehouse`）：
   - `/warehouse` 页面从只读展示升级为可交互豆仓管理页。
   - `我的豆仓` 区域支持空列表留白、右上角 `+` 展开新建豆仓表单。
   - 支持在页面内创建 MARD `96 / 144 / 291` 豆仓，并写入 `warehouse/inventory.json`。
   - 支持切换豆仓、查看健康度、查看项目缺豆概览。
   - 颜色库存支持按色号系列 `A / B / C / D / E / F / G / H / M ...` 圆形入口切换。
   - 颜色库存默认每页 `20` 条，右下角支持切换 `20 / 50 / 100`，并支持折叠。
   - 支持单色库存手动修改，写入 `transactions` 记录。
   - 支持手动补货文本导入，解析 `T1-500`、`T1 500`、`T1,500`、`T1：500` 等格式，同色号多行会合并。
   - 额外购买颜色必须属于 MARD 291 全色系；如果不在当前豆仓基础色板内，会标记为 `isExtraColor`。
   - 最近库存记录支持逐条删除；删除库存记录会删除该 transaction，并按该 transaction 的 `delta` 反向回滚库存数量。
   - 删除豆仓作为独立危险操作 section 展示；删除前二次确认。
   - 删除豆仓会从 `warehouse/inventory.json.warehouses` 移除对应豆仓，并删除该豆仓相关 `transactions`。
   - 删除豆仓前会检查 `results/projects/*/project.json` 是否绑定该豆仓；已绑定时拒绝删除。
   - 新增豆仓相关 API：`src/app/api/warehouse/list`、`create`、`update-item`、`replenish`、`delete`、`delete-transaction`。
   - 新增共享服务端逻辑：`src/lib/warehouseStore.ts`。
   - 新增豆仓删除 unit tests：`tests/warehouseStore.delete.test.ts`。
   - 新增 npm script：`npm run test:warehouse`。
   - 验证已通过：`npx tsc --noEmit --incremental false`、`npm run test:warehouse`、`/warehouse` 返回 200。

## Assumption 修改记录

### 2026-08-13 豆仓线

1. 库存流水存储形式：
   - 原 assumption：库存变化后续可能生成 CSV 或 log，形式未定。
   - 当前修改：第一版库存流水统一写入 `warehouse/inventory.json` 的 `transactions` 数组，属于 JSON log；暂不生成独立 CSV。
   - 后续如果需要导出，可在 JSON transactions 基础上增加 CSV export，不改变当前事实来源。

2. 删除库存记录的行为：
   - 原 assumption：删除库存记录只删除记录，不回滚库存数量。
   - 当前修改：删除库存记录会删除该 transaction，并按 transaction item 的 `delta` 反向回滚库存数量。
   - 规则：入库 `+N` 删除后库存 `-N`；出库 `-N` 删除后库存 `+N`；如果回滚会导致库存小于 0，则拒绝删除。

3. 删除豆仓的行为：
   - 原 assumption：第一版允许真删除，但前端入口和约束未落地。
   - 当前修改：删除豆仓是独立危险操作 section；二次确认后删除 `warehouse/inventory.json.warehouses[]` 对应豆仓，并删除该豆仓相关 `transactions[]`。
   - 安全约束：如果任意 `results/projects/*/project.json` 绑定该豆仓，则拒绝删除。

4. 豆仓颜色集合：
   - 原 assumption：豆仓是 MARD 任意数量颜色 + 拼豆所需额外颜色形成的自定义色板，额外颜色必须来自 MARD 291。
   - 当前落地：补货导入时允许新增当前基础色板外的 MARD 291 色号，并标记为 `isExtraColor`；非 MARD 291 色号拒绝导入。

## Out of Scope

旧阶段计划中的以下内容当前暂缓，不影响本阶段优先级：

1. 拼豆模式游戏化。
2. 成就系统。
3. 分享功能。
4. 时间记录。
5. 拍照记录。
6. 微信小程序 Canvas 架构。
7. 多品牌完整体验。

## 以后计划

### 大图性能具体策略

旧阶段计划中提到的虚拟化渲染、局部刷新、视口保持等大图性能策略放到后续阶段细化。

当前阶段只保留原则：

1. `.grid.json` 不保存可重新计算的大型冗余数据。
2. 项目列表只读摘要。
3. `colorCounts` 作为统计 section，避免计划脚本为了算豆数必须遍历整张大图。
4. CV 解析和图纸保存先保证正确性，再优化大图交互性能。

```txt
src/app/api/projects/save/route.ts
src/app/api/projects/list/route.ts
src/app/api/projects/load/route.ts
src/app/api/projects/create/route.ts
src/app/api/projects/[id]/route.ts
src/app/api/projects/[id]/delete/route.ts
src/app/api/projects/[id]/patterns/add/route.ts
src/app/api/projects/[id]/patterns/[patternId]/delete/route.ts
src/app/api/projects/[id]/patterns/[patternId]/complete/route.ts
src/app/api/projects/[id]/patterns/[patternId]/restore/route.ts
src/app/api/projects/[id]/summary/route.ts

src/app/api/warehouse/list/route.ts
src/app/api/warehouse/save/route.ts
src/app/api/warehouse/[id]/route.ts
src/app/api/warehouse/[id]/delete/route.ts

src/app/api/warehouse/plans/create/route.ts
src/app/api/warehouse/plans/update-status/route.ts
src/app/api/warehouse/plans/export-csv/route.ts
```

## MVP 实现顺序

1. 创建本地目录：`pic/`、`results/`、`warehouse/`。
2. 新增 MARD 颜色方案选择：`96`、`144`、`291`。
3. 切换颜色方案时计算方案外颜色的最近推荐色，首次切换先弹确认，用户确认后才批量应用。
4. 增加额外颜色列表，允许用户保留原始方案外颜色。
5. 新增图纸 `.grid.json` 保存 API。
6. 主页面新增“保存图纸/保存项目图纸”按钮和项目名输入。
7. 保存原图和 `.grid.json`，在 `.grid.json` 的 `colorCounts` 中记录豆数统计和 extra color 字段。
8. 支持从 `.grid.json` 重新加载回主编辑页面。
9. 主页面新增三个入口按钮：加载豆仓、加载图纸、加载项目。
10. 新增加载项目页面：展示项目文件夹列表，支持新建项目并选择绑定豆仓。
11. 新增项目页面：支持 `+` 加载图纸、按 `draft / in_progress / completed` 分区显示图纸、查看总需求和 Missing。
12. 新增 `/warehouse` 页面，包含返回主页、我的豆仓列表、豆仓切换、品牌/色系/健康度展示、颜色库存列表。
13. 支持创建豆仓、设置品牌、设置色板数量、录入每个颜色库存，并支持手动补货导入。
14. 支持点击项目内单张图纸完成图纸，二次确认后扣除绑定豆仓库存并写 transaction log。
15. 已完成时扣除库存，并防止重复扣除。

## 暂不做

第一版暂不做：

- Vercel 或云端部署。
- 用户账号。
- 数据库。
- 自动保存。
- 真正 `.xlsx` 导出。
- 按“买了几套”自动展开库存。
- 多品牌同时统计。



1 切换方案时是否直接改图
首次切换后先弹出确认列表，用户确认后才批量替换
第二次之后不需要确认



. 保留原始色是按颜色还是按区域

按颜色整体保留，不是按区域。后面允许用户用刷子来改变区域颜色

extra color 的库存归属
如果用户在 MARD 96 方案里保留了 R11，豆仓是 MARD 96，但仓库里面本来没有 R11。

3. extra color 的库存归属
页面应该：
豆仓页面显示额外购买颜色 


. 颜色方案和当前“管理色板”的关系
现在项目已有“管理色板 / customPaletteSelections”。新方案 MARD 96/144/291 和自定义色板要怎么共存？

颜色方案选择：MARD 96 / 144 / 291 / 自定义
选 MARD 96/144/291 时，自动更新当前 active palette
用户手动改色板后，方案显示为 自定义/ 
这个自定义 是我的豆仓色板方案（包含我拥有的颜色）


4. 
豆仓其实就是用户在mard 任意数量颜色上面增加拼豆需要的颜色作为新自定义色板， 这个颜色必须是mard 291全色系里面的颜色。

5.已完成扣库存是否允许撤销
计划状态从 进行中 -> 已完成 会扣库存。那如果用户误点，改回草稿：
每次扣库存 都是生成一个csv 或者log 记录 库存变化 以将计算根据（原有的库存 -用了哪个图纸）
