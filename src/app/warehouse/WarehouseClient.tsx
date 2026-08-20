'use client';

import Link from 'next/link';
import { FormEvent, useMemo, useState } from 'react';
import type { MardColor, MardPaletteOption, Warehouse, WarehouseInventory, WarehouseItem, WarehouseTransaction } from '@/lib/warehouseStore';

interface ProjectDemand {
  projectId: string;
  name: string;
  warehouseId: string;
  items: ProjectDemandItem[];
}

interface ProjectDemandItem {
  hex: string;
  colorKey: string;
  needed: number;
}

interface WarehouseClientProps {
  initialInventory: WarehouseInventory;
  paletteOptions: MardPaletteOption[];
  allMardColors: MardColor[];
  projectDemands: ProjectDemand[];
}

interface ApiResponse {
  ok: boolean;
  error?: string;
  inventory?: WarehouseInventory;
  warehouse?: Warehouse;
}

interface ReplenishPreviewEntry {
  colorKey: string;
  count: number;
  hex: string;
  alreadyInWarehouse: boolean;
  isExtraForWarehouse: boolean;
  lineCount: number;
}

interface ReplenishPreviewError {
  lineNumber: number;
  text: string;
  reason: string;
}

export default function WarehouseClient({ initialInventory, paletteOptions, allMardColors, projectDemands }: WarehouseClientProps) {
  const [inventory, setInventory] = useState<WarehouseInventory>(initialInventory);
  const [activeWarehouseId, setActiveWarehouseId] = useState(initialInventory.warehouses[0]?.id ?? '');
  const [createForm, setCreateForm] = useState({
    name: '',
    paletteName: paletteOptions[0]?.paletteName ?? '96',
    ownedCount: '0',
  });
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isInventoryCollapsed, setIsInventoryCollapsed] = useState(false);
  const [selectedColorSeries, setSelectedColorSeries] = useState('');
  const [inventoryPageSize, setInventoryPageSize] = useState(20);
  const [inventoryPage, setInventoryPage] = useState(1);
  const [replenishText, setReplenishText] = useState('');
  const [replenishNote, setReplenishNote] = useState('');
  const [draftCounts, setDraftCounts] = useState<Record<string, string>>({});
  const [expandedTransactionIds, setExpandedTransactionIds] = useState<string[]>([]);
  const [isRenamingWarehouse, setIsRenamingWarehouse] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [busyAction, setBusyAction] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const warehouses = inventory.warehouses ?? [];
  const activeWarehouse = warehouses.find((warehouse) => warehouse.id === activeWarehouseId) ?? warehouses[0] ?? null;
  const items = useMemo(
    () => (activeWarehouse?.items ?? []).slice().sort((a, b) => compareColorKeys(a.colorKey, b.colorKey)),
    [activeWarehouse]
  );
  const allColorMap = useMemo(() => new Map(allMardColors.map((color) => [normalizeColorKey(color.colorKey), color])), [allMardColors]);
  const totalStock = items.reduce((sum, item) => sum + Number(item.ownedCount || 0), 0);
  const extraColorCount = items.filter((item) => item.isExtraColor).length;
  const colorSeries = useMemo(() => buildColorSeries(items), [items]);
  const activeColorSeries = colorSeries.some((series) => series.prefix === selectedColorSeries)
    ? selectedColorSeries
    : colorSeries[0]?.prefix ?? '';
  const seriesItems = useMemo(
    () => items.filter((item) => getColorSeriesPrefix(item.colorKey) === activeColorSeries),
    [items, activeColorSeries]
  );
  const totalInventoryPages = Math.max(1, Math.ceil(seriesItems.length / inventoryPageSize));
  const currentInventoryPage = Math.min(inventoryPage, totalInventoryPages);
  const visibleInventoryItems = seriesItems.slice(
    (currentInventoryPage - 1) * inventoryPageSize,
    currentInventoryPage * inventoryPageSize
  );
  const activeDemand = useMemo(
    () => buildWarehouseDemand(activeWarehouse, projectDemands),
    [activeWarehouse, projectDemands]
  );
  const health = useMemo(() => calculateHealth(activeDemand), [activeDemand]);
  const preview = useMemo(
    () => buildReplenishPreview(replenishText, activeWarehouse, allColorMap),
    [replenishText, activeWarehouse, allColorMap]
  );
  const recentTransactions = (inventory.transactions ?? [])
    .filter((transaction) => transaction.warehouseId === activeWarehouse?.id)
    .slice(-5)
    .reverse();

  async function handleCreateWarehouse(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runMutation('create', async () => {
      const response = await postJson('/api/warehouse/create', {
        name: createForm.name,
        paletteName: createForm.paletteName,
        ownedCount: Number(createForm.ownedCount),
      });
      if (!response.inventory || !response.warehouse) throw new Error('创建豆仓返回数据不完整');
      setInventory(response.inventory);
      setActiveWarehouseId(response.warehouse.id);
      setCreateForm((current) => ({ ...current, name: '' }));
      setDraftCounts({});
      setIsCreateOpen(false);
      setSelectedColorSeries('');
      setInventoryPage(1);
      setMessage(`已创建豆仓：${response.warehouse.name}`);
    });
  }

  async function handleUpdateItem(item: WarehouseItem) {
    if (!activeWarehouse) return;
    const draftValue = draftCounts[item.colorKey] ?? String(item.ownedCount);
    const ownedCount = Number(draftValue);
    await runMutation(`item-${item.colorKey}`, async () => {
      const response = await postJson('/api/warehouse/update-item', {
        warehouseId: activeWarehouse.id,
        colorKey: item.colorKey,
        ownedCount,
        note: '修改库存',
      });
      if (!response.inventory) throw new Error('更新库存返回数据不完整');
      setInventory(response.inventory);
      setDraftCounts((current) => {
        const next = { ...current };
        delete next[item.colorKey];
        return next;
      });
      setMessage(`已更新 ${item.colorKey} 库存`);
    });
  }

  async function handleRenameWarehouse(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeWarehouse) return;
    await runMutation('rename-warehouse', async () => {
      const response = await postJson('/api/warehouse/rename', {
        warehouseId: activeWarehouse.id,
        name: renameDraft,
      });
      if (!response.inventory || !response.warehouse) throw new Error('修改豆仓名称返回数据不完整');
      setInventory(response.inventory);
      setActiveWarehouseId(response.warehouse.id);
      setIsRenamingWarehouse(false);
      setRenameDraft('');
      setMessage(`已改名为：${response.warehouse.name}`);
    });
  }

  async function handleReplenish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeWarehouse) return;
    if (preview.errors.length > 0) {
      setError('补货文本还有无法识别的行，先修正后再导入');
      return;
    }
    await runMutation('replenish', async () => {
      const response = await postJson('/api/warehouse/replenish', {
        warehouseId: activeWarehouse.id,
        entries: preview.entries.map((entry) => ({ colorKey: entry.colorKey, count: entry.count })),
        note: replenishNote,
      });
      if (!response.inventory) throw new Error('补货导入返回数据不完整');
      setInventory(response.inventory);
      setReplenishText('');
      setReplenishNote('');
      setDraftCounts({});
      setMessage(`已导入 ${preview.entries.length} 个色号的补货记录`);
    });
  }

  async function handleDeleteTransaction(transaction: WarehouseTransaction) {
    if (!activeWarehouse) return;
    const confirmed = window.confirm('确定删除这条库存记录吗？只会删除记录且回滚库存数量。');
    if (!confirmed) return;

    await runMutation(`delete-transaction-${transaction.id}`, async () => {
      const response = await postJson('/api/warehouse/delete-transaction', {
        warehouseId: activeWarehouse.id,
        transactionId: transaction.id,
      });
      if (!response.inventory) throw new Error('删除库存记录返回数据不完整');
      setInventory(response.inventory);
      setMessage('已删除库存记录并回滚库存数量');
    });
  }

  async function handleDeleteWarehouse() {
    if (!activeWarehouse) return;
    const confirmed = window.confirm(`确定删除豆仓「${activeWarehouse.name}」吗？这个操作会删除该豆仓和它的库存记录，不能撤销。`);
    if (!confirmed) return;

    await runMutation('delete-warehouse', async () => {
      const response = await postJson('/api/warehouse/delete', {
        warehouseId: activeWarehouse.id,
      });
      if (!response.inventory) throw new Error('删除豆仓返回数据不完整');
      const nextWarehouseId = response.inventory.warehouses[0]?.id ?? '';
      setInventory(response.inventory);
      setActiveWarehouseId(nextWarehouseId);
      setDraftCounts({});
      setSelectedColorSeries('');
      setInventoryPage(1);
      setMessage(`已删除豆仓：${activeWarehouse.name}`);
    });
  }

  function toggleTransactionDetails(transactionId: string) {
    setExpandedTransactionIds((current) => (
      current.includes(transactionId)
        ? current.filter((id) => id !== transactionId)
        : [...current, transactionId]
    ));
  }

  async function runMutation(action: string, mutate: () => Promise<void>) {
    setBusyAction(action);
    setError('');
    setMessage('');
    try {
      await mutate();
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : '操作失败');
    } finally {
      setBusyAction('');
    }
  }

  return (
    <main className="min-h-screen bg-slate-50 text-slate-950">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-3 border-b border-slate-200 pb-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <Link href="/" className="text-sm font-medium text-slate-500 hover:text-slate-900">返回主页</Link>
            <h1 className="mt-1 text-2xl font-semibold tracking-normal">加载豆仓</h1>
          </div>
          <div className="relative z-20 flex flex-wrap gap-2">
            <Link
              href="/projects"
              prefetch={false}
              className="inline-flex h-10 items-center justify-center rounded border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-100"
            >
              加载项目
            </Link>
            <Link
              href="/analysis"
              prefetch={false}
              className="inline-flex h-10 items-center justify-center rounded bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700"
            >
              加载图纸
            </Link>
          </div>
        </header>

        {(message || error) && (
          <div className={`rounded border px-4 py-3 text-sm ${error ? 'border-red-200 bg-red-50 text-red-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}>
            {error || message}
          </div>
        )}

        <section className="grid gap-4 lg:grid-cols-[340px_1fr]">
          <aside className="flex flex-col gap-4">
            <section className="rounded border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-base font-semibold">我的豆仓</h2>
                <button
                  type="button"
                  onClick={() => setIsCreateOpen((current) => !current)}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-slate-300 bg-white text-xl leading-none text-slate-700 hover:bg-slate-50"
                  aria-label={isCreateOpen ? '收起新建豆仓' : '新建豆仓'}
                  title={isCreateOpen ? '收起新建豆仓' : '新建豆仓'}
                >
                  {isCreateOpen ? '-' : '+'}
                </button>
              </div>
              {warehouses.length === 0 ? (
                <div className="mt-3 min-h-8" />
              ) : (
                <div className="mt-3 flex flex-col gap-2">
                  {warehouses.map((warehouse) => {
                    const warehouseItems = warehouse.items ?? [];
                    const warehouseTotal = warehouseItems.reduce((sum, item) => sum + Number(item.ownedCount || 0), 0);
                    const warehouseHealth = calculateHealth(buildWarehouseDemand(warehouse, projectDemands));
                    return (
                      <button
                        key={warehouse.id}
                        type="button"
                        onClick={() => {
                          setActiveWarehouseId(warehouse.id);
                          setDraftCounts({});
                          setSelectedColorSeries('');
                          setInventoryPage(1);
                          setError('');
                          setMessage('');
                        }}
                        className={`rounded border p-3 text-left text-sm transition ${
                          warehouse.id === activeWarehouse?.id ? 'border-slate-900 bg-slate-50' : 'border-slate-200 bg-white hover:bg-slate-50'
                        }`}
                      >
                        <div className="font-semibold">{warehouse.name}</div>
                        <div className="mt-1 text-slate-500">{warehouse.brand} {warehouse.paletteName} · {warehouseItems.length} 色 · {warehouseTotal} 颗</div>
                        <div className={`mt-2 inline-flex rounded border px-2 py-1 text-xs ${warehouseHealth.className}`}>{warehouseHealth.label}</div>
                      </button>
                    );
                  })}
                </div>
              )}

              {isCreateOpen && (
                <form className="mt-4 flex flex-col gap-3 border-t border-slate-100 pt-4" onSubmit={handleCreateWarehouse}>
                  <h3 className="text-sm font-semibold">新建豆仓</h3>
                  <label className="text-sm">
                    <span className="font-medium text-slate-700">名称</span>
                    <input
                      value={createForm.name}
                      onChange={(event) => setCreateForm((current) => ({ ...current, name: event.target.value }))}
                      className="mt-1 h-11 w-full rounded border border-slate-300 px-3 text-sm outline-none focus:border-blue-500"
                      placeholder="例如：豆仓2"
                    />
                  </label>
                  <label className="text-sm">
                    <span className="font-medium text-slate-700">品牌</span>
                    <input
                      value="MARD"
                      disabled
                      className="mt-1 h-11 w-full rounded border border-slate-200 bg-slate-50 px-3 text-sm text-slate-500"
                    />
                  </label>
                  <div className="text-sm">
                    <div className="font-medium text-slate-700">色板</div>
                    <div className="mt-2 grid grid-cols-1 gap-2">
                      {paletteOptions.map((option) => {
                        const isSelected = createForm.paletteName === option.paletteName;
                        return (
                          <button
                            key={option.paletteName}
                            type="button"
                            aria-pressed={isSelected}
                            onClick={() => setCreateForm((current) => ({ ...current, paletteName: option.paletteName }))}
                            className={`min-h-16 rounded border px-3 py-3 text-left transition ${
                              isSelected
                                ? 'border-slate-950 bg-slate-950 text-white shadow-sm'
                                : 'border-slate-300 bg-white text-slate-700 hover:border-slate-400 hover:bg-slate-50'
                            }`}
                          >
                            <span className="block text-base font-semibold">MARD {option.paletteName}</span>
                            <span className={`mt-1 block text-sm ${isSelected ? 'text-slate-200' : 'text-slate-500'}`}>
                              {option.colorCount} 色
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <label className="text-sm">
                    <span className="font-medium text-slate-700">每色初始库存</span>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={createForm.ownedCount}
                      onChange={(event) => setCreateForm((current) => ({ ...current, ownedCount: event.target.value }))}
                      className="mt-1 h-11 w-full rounded border border-slate-300 px-3 text-sm outline-none focus:border-blue-500"
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={busyAction === 'create'}
                    className="inline-flex h-11 items-center justify-center rounded bg-slate-950 px-4 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {busyAction === 'create' ? '创建中...' : '创建豆仓'}
                  </button>
                </form>
              )}
            </section>
          </aside>

          {!activeWarehouse ? (
            <EmptyState text="先创建一个豆仓，然后就可以在这里维护库存。" />
          ) : (
            <section className="flex flex-col gap-4">
              <section className="rounded border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    {isRenamingWarehouse ? (
                      <form className="flex max-w-md flex-wrap items-center gap-2" onSubmit={handleRenameWarehouse}>
                        <input
                          value={renameDraft}
                          onChange={(event) => setRenameDraft(event.target.value)}
                          className="h-9 min-w-0 flex-1 rounded border border-slate-300 px-3 text-base font-semibold outline-none focus:border-blue-500"
                          autoFocus
                        />
                        <button
                          type="submit"
                          disabled={busyAction === 'rename-warehouse' || !renameDraft.trim()}
                          className="h-9 rounded bg-blue-600 px-3 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          保存
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setIsRenamingWarehouse(false);
                            setRenameDraft('');
                          }}
                          className="h-9 rounded border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
                        >
                          取消
                        </button>
                      </form>
                    ) : (
                      <div className="flex items-center gap-2">
                        <h2 className="text-lg font-semibold">{activeWarehouse.name}</h2>
                        <button
                          type="button"
                          onClick={() => {
                            setRenameDraft(activeWarehouse.name);
                            setIsRenamingWarehouse(true);
                          }}
                          className="inline-flex h-8 w-8 items-center justify-center rounded border border-slate-200 bg-white text-slate-500 hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900"
                          aria-label="修改豆仓名称"
                          title="修改豆仓名称"
                        >
                          <span aria-hidden="true">✎</span>
                        </button>
                      </div>
                    )}
                    <p className="mt-1 text-sm text-slate-500">
                      {activeWarehouse.brand} {activeWarehouse.paletteName} · {items.length} 色 · 共 {totalStock} 颗
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-center text-sm sm:grid-cols-4">
                    <Stat label="色号" value={String(items.length)} />
                    <Stat label="库存" value={String(totalStock)} />
                    <Stat label="额外色" value={String(extraColorCount)} tone={extraColorCount > 0 ? 'info' : undefined} />
                    <Stat label="健康度" value={health.label} tone={health.tone} />
                  </div>
                </div>

                {activeDemand.items.length > 0 && (
                  <div className="mt-4 rounded border border-slate-200 bg-slate-50 p-3">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div className="text-sm font-semibold">项目缺豆概览</div>
                      <div className="flex flex-wrap gap-2 text-sm">
                        {activeDemand.projects.map((project) => (
                          <Link
                            key={project.projectId}
                            href={`/projects/${encodeURIComponent(project.projectId)}`}
                            className="rounded border border-slate-200 bg-white px-2 py-1 font-medium text-slate-700 hover:border-blue-300 hover:text-blue-700"
                          >
                            {project.name}
                          </Link>
                        ))}
                        <Link
                          href="/projects"
                          className="rounded border border-slate-200 bg-white px-2 py-1 font-medium text-slate-500 hover:border-slate-300 hover:text-slate-900"
                        >
                          全部项目
                        </Link>
                      </div>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-center text-sm sm:grid-cols-4">
                      <Stat label="计划需求" value={String(activeDemand.totalNeeded)} />
                      <Stat label="缺豆" value={String(activeDemand.totalMissing)} tone={activeDemand.totalMissing > 0 ? 'warn' : 'ok'} />
                      <Stat label="缺色" value={String(activeDemand.missingItems.length)} tone={activeDemand.missingItems.length > 0 ? 'warn' : 'ok'} />
                      <Stat label="计划色" value={String(activeDemand.items.length)} />
                    </div>
                  </div>
                )}
              </section>

              <section className="grid gap-4 xl:grid-cols-[1fr_1fr]">
                <section className="rounded border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                    <h3 className="text-base font-semibold">补货导入</h3>
                    <span className="text-sm text-slate-500">支持 T1-500 / T1 500 / T1,500</span>
                  </div>
                  <form className="mt-3 flex flex-col gap-3" onSubmit={handleReplenish}>
                    <textarea
                      value={replenishText}
                      onChange={(event) => setReplenishText(event.target.value)}
                      className="min-h-[132px] resize-y rounded border border-slate-300 p-3 text-sm outline-none focus:border-blue-500"
                      placeholder={'T1-500\nH7-300\nR11：100'}
                    />
                    <input
                      value={replenishNote}
                      onChange={(event) => setReplenishNote(event.target.value)}
                      className="h-10 rounded border border-slate-300 px-3 text-sm outline-none focus:border-blue-500"
                      placeholder="备注，默认：补货导入"
                    />
                    <button
                      type="submit"
                      disabled={busyAction === 'replenish' || preview.entries.length === 0 || preview.errors.length > 0}
                      className="inline-flex h-10 items-center justify-center rounded bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {busyAction === 'replenish' ? '导入中...' : '导入到豆仓'}
                    </button>
                  </form>
                </section>

                <section className="rounded border border-slate-200 bg-white p-4 shadow-sm">
                  <h3 className="text-base font-semibold">解析预览</h3>
                  {preview.entries.length === 0 && preview.errors.length === 0 ? (
                    <p className="mt-3 text-sm text-slate-500">粘贴补货文本后会在这里预览合并结果。</p>
                  ) : (
                    <div className="mt-3 flex flex-col gap-3">
                      {preview.entries.length > 0 && (
                        <div className="overflow-auto rounded border border-slate-100">
                          <table className="w-full min-w-[460px] border-collapse text-sm">
                            <thead>
                              <tr className="border-b border-slate-200 bg-slate-50 text-left text-slate-500">
                                <th className="px-3 py-2">色号</th>
                                <th className="px-3 py-2">颜色</th>
                                <th className="px-3 py-2 text-right">补货</th>
                                <th className="px-3 py-2">状态</th>
                              </tr>
                            </thead>
                            <tbody>
                              {preview.entries.map((entry) => (
                                <tr key={entry.colorKey} className="border-b border-slate-100 last:border-b-0">
                                  <td className="px-3 py-2 font-semibold">{entry.colorKey}</td>
                                  <td className="px-3 py-2">
                                    <span className="inline-flex items-center gap-2">
                                      <span className="h-6 w-6 rounded border border-slate-300" style={{ backgroundColor: entry.hex }} />
                                      <span className="text-xs text-slate-500">{entry.hex}</span>
                                    </span>
                                  </td>
                                  <td className="px-3 py-2 text-right">{entry.count}</td>
                                  <td className="px-3 py-2 text-slate-600">
                                    {entry.isExtraForWarehouse ? '额外购买颜色' : entry.alreadyInWarehouse ? '已有色号' : '新色号'}
                                    {entry.lineCount > 1 ? ` · 已合并 ${entry.lineCount} 行` : ''}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                      {preview.errors.length > 0 && (
                        <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                          <div className="font-semibold">需要修正的行</div>
                          <div className="mt-2 flex flex-col gap-1">
                            {preview.errors.map((row) => (
                              <div key={`${row.lineNumber}-${row.text}`}>第 {row.lineNumber} 行：{row.text} · {row.reason}</div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </section>
              </section>

              <section className="rounded border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h3 className="text-base font-semibold">颜色库存</h3>
                    <p className="mt-1 text-sm text-slate-500">修改数字后点击保存，补货导入会自动累加。</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsInventoryCollapsed((current) => !current)}
                    className="inline-flex h-9 items-center justify-center rounded border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    {isInventoryCollapsed ? '展开' : '收起'}
                  </button>
                </div>

                {!isInventoryCollapsed && (
                  <>
                    <div className="mt-4 flex flex-wrap gap-2">
                      {colorSeries.map((series) => (
                        <button
                          key={series.prefix}
                          type="button"
                          onClick={() => {
                            setSelectedColorSeries(series.prefix);
                            setInventoryPage(1);
                          }}
                          className={`flex h-12 w-12 flex-col items-center justify-center rounded-full border text-sm font-semibold transition ${
                            activeColorSeries === series.prefix
                              ? 'border-slate-950 bg-slate-950 text-white'
                              : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                          }`}
                          title={`${series.prefix} 系列 · ${series.count} 色`}
                        >
                          <span>{series.prefix}</span>
                          <span className={`text-[10px] font-medium ${activeColorSeries === series.prefix ? 'text-slate-200' : 'text-slate-400'}`}>{series.count}</span>
                        </button>
                      ))}
                    </div>

                    <div className="mt-4 overflow-auto rounded border border-slate-100">
                      <table className="w-full min-w-[680px] border-collapse text-sm">
                        <thead>
                          <tr className="border-b border-slate-200 bg-slate-50 text-left text-slate-500">
                            <th className="px-3 py-2">色号</th>
                            <th className="px-3 py-2">颜色</th>
                            <th className="px-3 py-2">Hex</th>
                            <th className="px-3 py-2">来源</th>
                            <th className="px-3 py-2 text-right">库存</th>
                            <th className="px-3 py-2 text-right">操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {visibleInventoryItems.map((item) => {
                            const draftValue = draftCounts[item.colorKey] ?? String(item.ownedCount);
                            const changed = Number(draftValue) !== Number(item.ownedCount);
                            const actionKey = `item-${item.colorKey}`;
                            return (
                              <tr key={`${item.hex}-${item.colorKey}`} className="border-b border-slate-100 last:border-b-0">
                                <td className="px-3 py-2 font-semibold">{item.colorKey}</td>
                                <td className="px-3 py-2">
                                  <span className="inline-flex h-6 w-6 rounded border border-slate-300" style={{ backgroundColor: item.hex }} />
                                </td>
                                <td className="px-3 py-2 text-slate-500">{item.hex}</td>
                                <td className="px-3 py-2">
                                  <span className={`rounded border px-2 py-1 text-xs ${item.isExtraColor ? 'border-blue-200 bg-blue-50 text-blue-700' : 'border-slate-200 bg-slate-50 text-slate-600'}`}>
                                    {item.isExtraColor ? '额外色' : `MARD ${item.sourcePaletteName || activeWarehouse.paletteName}`}
                                  </span>
                                </td>
                                <td className="px-3 py-2 text-right">
                                  <input
                                    type="number"
                                    min="0"
                                    step="1"
                                    value={draftValue}
                                    onChange={(event) => setDraftCounts((current) => ({ ...current, [item.colorKey]: event.target.value }))}
                                    className="h-9 w-28 rounded border border-slate-300 px-2 text-right text-sm outline-none focus:border-blue-500"
                                  />
                                </td>
                                <td className="px-3 py-2 text-right">
                                  <button
                                    type="button"
                                    disabled={!changed || busyAction === actionKey}
                                    onClick={() => handleUpdateItem(item)}
                                    className="inline-flex h-9 items-center justify-center rounded border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                                  >
                                    {busyAction === actionKey ? '保存中' : '保存'}
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>

                    <div className="mt-3 flex flex-col gap-3 text-sm text-slate-500 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        {activeColorSeries ? `${activeColorSeries} 系列：${seriesItems.length} 色` : '无颜色'}
                        {seriesItems.length > 0 ? ` · 第 ${currentInventoryPage} / ${totalInventoryPages} 页` : ''}
                      </div>
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <button
                          type="button"
                          disabled={currentInventoryPage <= 1}
                          onClick={() => setInventoryPage((page) => Math.max(1, page - 1))}
                          className="h-9 rounded border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          上一页
                        </button>
                        <button
                          type="button"
                          disabled={currentInventoryPage >= totalInventoryPages}
                          onClick={() => setInventoryPage((page) => Math.min(totalInventoryPages, page + 1))}
                          className="h-9 rounded border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          下一页
                        </button>
                        <select
                          value={inventoryPageSize}
                          onChange={(event) => {
                            setInventoryPageSize(Number(event.target.value));
                            setInventoryPage(1);
                          }}
                          className="h-9 rounded border border-slate-300 bg-white px-2 text-sm text-slate-700 outline-none focus:border-blue-500"
                        >
                          <option value={10}>10 / 页</option>
                          <option value={20}>20 / 页</option>
                          <option value={50}>50 / 页</option>
                        </select>
                      </div>
                    </div>
                  </>
                )}
              </section>

              <section className="rounded border border-slate-200 bg-white p-4 shadow-sm">
                <h3 className="text-base font-semibold">最近库存记录</h3>
                {recentTransactions.length === 0 ? (
                  <div className="mt-3 rounded border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
                    暂无库存记录
                  </div>
                ) : (
                  <div className="mt-3 flex flex-col gap-2 text-sm">
                    {recentTransactions.map((transaction) => {
                      const actionKey = `delete-transaction-${transaction.id}`;
                      const normalizedNote = normalizeTransactionNote(transaction.note);
                      const netDelta = transaction.items.reduce((sum, item) => sum + item.delta, 0);
                      const isExpanded = expandedTransactionIds.includes(transaction.id);
                      const hasDetails = transaction.items.length > 0 || Boolean(normalizedNote);
                      return (
                        <div key={transaction.id} className="rounded border border-slate-100 bg-slate-50 p-3">
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                                <span className="font-medium text-slate-800">{transactionLabel(transaction.type)}</span>
                                <span className="text-slate-500">{formatDateTime(transaction.createdAt)}</span>
                                <span className={netDelta >= 0 ? 'font-medium text-emerald-700' : 'font-medium text-red-700'}>
                                  净变化 {formatSignedDelta(netDelta)} 颗
                                </span>
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-3">
                              {hasDetails && (
                                <button
                                  type="button"
                                  onClick={() => toggleTransactionDetails(transaction.id)}
                                  className="text-sm font-medium text-blue-700 hover:text-blue-800"
                                >
                                  {isExpanded ? '收起' : '详情'}
                                </button>
                              )}
                              <button
                                type="button"
                                disabled={busyAction === actionKey}
                                onClick={() => handleDeleteTransaction(transaction)}
                                className="text-sm font-medium text-red-600 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {busyAction === actionKey ? '删除中' : '删除'}
                              </button>
                            </div>
                          </div>
                          {isExpanded && (
                            <div className="mt-3 max-h-48 overflow-y-auto rounded border border-slate-200 bg-white p-3 text-sm text-slate-600">
                              {normalizedNote && (
                                <div className="font-medium text-slate-700">{normalizedNote}</div>
                              )}
                              {transaction.items.length > 0 ? (
                                <div className={normalizedNote ? 'mt-2 flex flex-col gap-2' : 'flex flex-col gap-2'}>
                                  {transaction.items.map((item, index) => (
                                    <div
                                      key={`${transaction.id}-${item.colorKey}-${index}`}
                                      className="flex items-center justify-between gap-4 border-b border-slate-100 pb-2 last:border-b-0 last:pb-0"
                                    >
                                      <span className="inline-flex items-center gap-2 font-semibold text-slate-700">
                                        <span
                                          className="h-4 w-4 rounded border border-slate-300"
                                          style={{ backgroundColor: item.hex }}
                                        />
                                        {item.colorKey}
                                      </span>
                                      <span className={item.delta >= 0 ? 'text-emerald-700' : 'text-red-700'}>
                                        {formatSignedDelta(item.delta)} 颗
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <div className="mt-2 text-slate-400">没有颜色明细</div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

              </section>

              <section className="rounded border border-red-200 bg-white p-4 shadow-sm">
                <h3 className="text-base font-semibold text-red-700">删除豆仓</h3>
                <p className="mt-1 text-sm text-slate-500">删除后会从 warehouse/inventory.json 移除这个豆仓和它的库存记录。</p>
                <button
                  type="button"
                  disabled={busyAction === 'delete-warehouse'}
                  onClick={handleDeleteWarehouse}
                  className="mt-4 inline-flex h-10 items-center justify-center rounded border border-red-300 bg-white px-4 text-sm font-semibold text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busyAction === 'delete-warehouse' ? '删除中' : '删除'}
                </button>
              </section>
            </section>
          )}
        </section>
      </div>
    </main>
  );
}

async function postJson(url: string, body: unknown): Promise<ApiResponse> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as ApiResponse;
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || '请求失败');
  }
  return payload;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' | 'info' }) {
  const toneClass = tone === 'warn'
    ? 'text-red-700'
    : tone === 'ok'
      ? 'text-emerald-700'
      : tone === 'info'
        ? 'text-blue-700'
        : 'text-slate-950';
  return (
    <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`mt-1 font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="rounded border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
      {text}
    </div>
  );
}

function buildReplenishPreview(text: string, warehouse: Warehouse | null, allColorMap: Map<string, MardColor>) {
  const merged = new Map<string, ReplenishPreviewEntry>();
  const errors: ReplenishPreviewError[] = [];
  const warehouseKeys = new Set((warehouse?.items ?? []).map((item) => normalizeColorKey(item.colorKey)));
  const baseWarehouseKeys = new Set((warehouse?.items ?? []).filter((item) => !item.isExtraColor).map((item) => normalizeColorKey(item.colorKey)));

  text.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;

    const parsed = parseReplenishLine(line);
    if (!parsed) {
      errors.push({ lineNumber: index + 1, text: line, reason: '无法识别色号和数量' });
      return;
    }
    if (parsed.count <= 0) {
      errors.push({ lineNumber: index + 1, text: line, reason: '数量必须大于 0' });
      return;
    }

    const color = allColorMap.get(parsed.colorKey);
    if (!color) {
      errors.push({ lineNumber: index + 1, text: line, reason: '不在 MARD 291 全色系中' });
      return;
    }

    const current = merged.get(parsed.colorKey);
    if (current) {
      current.count += parsed.count;
      current.lineCount += 1;
    } else {
      merged.set(parsed.colorKey, {
        colorKey: parsed.colorKey,
        count: parsed.count,
        hex: color.hex,
        alreadyInWarehouse: warehouseKeys.has(parsed.colorKey),
        isExtraForWarehouse: !baseWarehouseKeys.has(parsed.colorKey),
        lineCount: 1,
      });
    }
  });

  return {
    entries: Array.from(merged.values()).sort((a, b) => compareColorKeys(a.colorKey, b.colorKey)),
    errors,
  };
}

function parseReplenishLine(line: string): { colorKey: string; count: number } | null {
  const normalized = line
    .replace(/[，,：:]/g, ' ')
    .replace(/[＋+]/g, ' ')
    .replace(/[颗粒个]/g, '')
    .replace(/[-–—]/g, ' ');
  const match = normalized.match(/^([A-Za-z]+)\s*0*(\d+)\s+(\d+)\b/);
  if (!match) return null;
  return {
    colorKey: `${match[1].toUpperCase()}${Number(match[2])}`,
    count: Number(match[3]),
  };
}

function buildWarehouseDemand(warehouse: Warehouse | null, projectDemands: ProjectDemand[]) {
  if (!warehouse) {
    return {
      items: [],
      missingItems: [],
      totalNeeded: 0,
      totalMissing: 0,
      projects: [],
    };
  }

  const stock = new Map((warehouse.items ?? []).map((item) => [normalizeColorKey(item.colorKey), Number(item.ownedCount || 0)]));
  const demand = new Map<string, ProjectDemandItem>();
  const projects: Array<{ projectId: string; name: string }> = [];

  for (const project of projectDemands) {
    if (project.warehouseId !== warehouse.id) continue;
    projects.push({ projectId: project.projectId, name: project.name });
    for (const item of project.items) {
      const colorKey = normalizeColorKey(item.colorKey);
      if (!colorKey) continue;
      const current = demand.get(colorKey);
      if (current) {
        current.needed += Number(item.needed || 0);
      } else {
        demand.set(colorKey, {
          colorKey,
          hex: item.hex,
          needed: Number(item.needed || 0),
        });
      }
    }
  }

  const items = Array.from(demand.values()).map((item) => {
    const owned = stock.get(item.colorKey) ?? 0;
    const missing = Math.max(0, item.needed - owned);
    return { ...item, owned, missing };
  }).sort((a, b) => compareColorKeys(a.colorKey, b.colorKey));

  return {
    items,
    missingItems: items.filter((item) => item.missing > 0),
    totalNeeded: items.reduce((sum, item) => sum + item.needed, 0),
    totalMissing: items.reduce((sum, item) => sum + item.missing, 0),
    projects,
  };
}

function calculateHealth(demand: ReturnType<typeof buildWarehouseDemand>) {
  if (demand.items.length === 0) {
    return {
      label: '未开始',
      tone: 'info' as const,
      className: 'border-slate-200 bg-slate-50 text-slate-600',
    };
  }
  if (demand.missingItems.length === 0) {
    return {
      label: '健康',
      tone: 'ok' as const,
      className: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    };
  }

  const hasZeroStock = demand.missingItems.some((item) => item.owned === 0);
  const isSevere = hasZeroStock || demand.missingItems.length > demand.items.length * 0.5;
  return {
    label: isSevere ? '缺口高' : '需补货',
    tone: 'warn' as const,
    className: isSevere ? 'border-red-200 bg-red-50 text-red-700' : 'border-amber-200 bg-amber-50 text-amber-700',
  };
}

function transactionLabel(type: string): string {
  switch (type) {
    case 'create_warehouse':
      return '创建豆仓';
    case 'manual_adjustment':
      return '修改库存';
    case 'manual_replenishment':
      return '补货';
    default:
      return '库存记录';
  }
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function formatSignedDelta(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function normalizeTransactionNote(note: string): string {
  return String(note || '')
    .replace('豆仓页面手动修改库存', '修改库存')
    .replace('手动修改库存', '修改库存')
    .replace('手动补货导入', '补货导入');
}

function buildColorSeries(items: WarehouseItem[]): Array<{ prefix: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const prefix = getColorSeriesPrefix(item.colorKey);
    if (!prefix) continue;
    counts.set(prefix, (counts.get(prefix) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([prefix, count]) => ({ prefix, count }))
    .sort((a, b) => compareSeriesPrefixes(a.prefix, b.prefix));
}

function getColorSeriesPrefix(colorKey: string): string {
  return /^([A-Za-z]+)/.exec(normalizeColorKey(colorKey))?.[1] ?? '';
}

function compareSeriesPrefixes(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true });
}

function compareColorKeys(a: string, b: string): number {
  const parsedA = parseColorKey(a);
  const parsedB = parseColorKey(b);
  if (parsedA.prefix !== parsedB.prefix) return parsedA.prefix.localeCompare(parsedB.prefix, 'en');
  if (parsedA.number !== parsedB.number) return parsedA.number - parsedB.number;
  return a.localeCompare(b, 'en', { numeric: true });
}

function parseColorKey(colorKey: string): { prefix: string; number: number } {
  const match = /^([A-Za-z]+)\s*0*(\d+)/.exec(colorKey);
  return {
    prefix: match?.[1]?.toUpperCase() ?? colorKey.toUpperCase(),
    number: match ? Number(match[2]) : Number.MAX_SAFE_INTEGER,
  };
}

function normalizeColorKey(colorKey: string): string {
  return String(colorKey || '').trim().toUpperCase();
}
