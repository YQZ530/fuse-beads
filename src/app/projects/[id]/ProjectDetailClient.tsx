'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormEvent, useMemo, useState } from 'react';
import type {
  AvailablePattern,
  ProjectDetailFile,
  ProjectPattern,
  ProjectPatternDetail,
  ProjectRequirementItem,
  ProjectStatus,
} from '../../api/projects/_projectStore';

interface ProjectDetailClientProps {
  initialProject: ProjectDetailFile;
}

interface StatusResponse {
  ok: boolean;
  error?: string;
  project?: ProjectDetailFile;
}

type DraftViewMode = 'list' | 'thumbnail';

export default function ProjectDetailClient({ initialProject }: ProjectDetailClientProps) {
  const router = useRouter();
  const [project, setProject] = useState(initialProject);
  const [availableViewMode, setAvailableViewMode] = useState<DraftViewMode>('list');
  const [draftViewMode, setDraftViewMode] = useState<DraftViewMode>('list');
  const [selectedAvailableIds, setSelectedAvailableIds] = useState<Set<string>>(new Set());
  const [selectedDraftIds, setSelectedDraftIds] = useState<Set<string>>(new Set());
  const [selectedInProgressIds, setSelectedInProgressIds] = useState<Set<string>>(new Set());
  const [activePreviewId, setActivePreviewId] = useState('');
  const [isRenamingProject, setIsRenamingProject] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [busyAction, setBusyAction] = useState('');
  const [deleteConfirmName, setDeleteConfirmName] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const groupedPatterns = useMemo(() => ({
    draft: project.patterns.filter((pattern) => pattern.status === 'draft'),
    in_progress: project.patterns.filter((pattern) => pattern.status === 'in_progress'),
    completed: project.patterns.filter((pattern) => pattern.status === 'completed'),
  }), [project.patterns]);

  const activePreviewPattern = groupedPatterns.draft.find((pattern) => pattern.id === activePreviewId)
    ?? null;
  const missingItems = project.missingItems
    .slice()
    .sort((a, b) => b.missing - a.missing || compareColorKeys(a.colorKey, b.colorKey));
  const requirementItems = project.items
    .slice()
    .sort((a, b) => compareColorKeys(a.colorKey, b.colorKey));
  const requirementSourceLabel = formatRequirementSourceLabel(project.patterns.filter((pattern) => (
    pattern.status === 'draft' || pattern.status === 'in_progress'
  )));

  async function handleRenameProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextName = renameDraft.trim();
    if (!nextName) {
      setError('项目名称不能为空');
      return;
    }

    setBusyAction('rename-project');
    setMessage('');
    setError('');

    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nextName }),
      });
      const payload = (await response.json()) as StatusResponse;
      if (!response.ok || !payload.ok || !payload.project) {
        throw new Error(payload.error || '修改项目名称失败');
      }

      setProject(payload.project);
      setIsRenamingProject(false);
      setRenameDraft('');
      setMessage(`已改名为：${payload.project.name}`);
    } catch (renameError) {
      setError(renameError instanceof Error ? renameError.message : '修改项目名称失败');
    } finally {
      setBusyAction('');
    }
  }

  async function movePatternSelection({
    patternIds,
    status,
    actionKey,
    clearSelection,
  }: {
    patternIds: Set<string>;
    status: ProjectStatus;
    actionKey: string;
    clearSelection: () => void;
  }) {
    if (patternIds.size === 0) return;
    setBusyAction(actionKey);
    setMessage('');
    setError('');

    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}/patterns/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          patternIds: Array.from(patternIds),
          status,
        }),
      });
      const payload = (await response.json()) as StatusResponse;
      if (!response.ok || !payload.ok || !payload.project) {
        throw new Error(payload.error || '移动图纸状态失败');
      }

      setProject(payload.project);
      clearSelection();
      setActivePreviewId('');
      setMessage(`已移动 ${patternIds.size} 张图纸到${status === 'draft' ? '计划' : statusLabel(status)}`);
    } catch (moveError) {
      setError(moveError instanceof Error ? moveError.message : '移动图纸状态失败');
    } finally {
      setBusyAction('');
    }
  }

  async function addAvailableSelection() {
    if (selectedAvailableIds.size === 0) return;
    setBusyAction('add-available-patterns');
    setMessage('');
    setError('');

    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}/patterns/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patternIds: Array.from(selectedAvailableIds) }),
      });
      const payload = (await response.json()) as StatusResponse;
      if (!response.ok || !payload.ok || !payload.project) {
        throw new Error(payload.error || '添加图纸失败');
      }

      setProject(payload.project);
      setSelectedAvailableIds(new Set());
      setMessage(`已添加 ${selectedAvailableIds.size} 张图纸到草稿`);
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : '添加图纸失败');
    } finally {
      setBusyAction('');
    }
  }

  async function removeDraftSelection() {
    if (selectedDraftIds.size === 0) return;
    setBusyAction('remove-draft-patterns');
    setMessage('');
    setError('');

    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}/patterns/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patternIds: Array.from(selectedDraftIds) }),
      });
      const payload = (await response.json()) as StatusResponse;
      if (!response.ok || !payload.ok || !payload.project) {
        throw new Error(payload.error || '移除图纸失败');
      }

      setProject(payload.project);
      setSelectedDraftIds(new Set());
      setActivePreviewId('');
      setMessage(`已从项目移除 ${selectedDraftIds.size} 张草稿图纸`);
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : '移除图纸失败');
    } finally {
      setBusyAction('');
    }
  }

  async function deleteCurrentProject() {
    setBusyAction('delete-project');
    setMessage('');
    setError('');

    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmName: deleteConfirmName }),
      });
      const payload = (await response.json()) as { ok: boolean; error?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || '删除项目失败');
      }
      router.push('/projects');
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : '删除项目失败');
    } finally {
      setBusyAction('');
    }
  }

  function toggleDraftSelection(patternId: string) {
    setSelectedDraftIds((current) => {
      const next = new Set(current);
      if (next.has(patternId)) {
        next.delete(patternId);
      } else {
        next.add(patternId);
      }
      return next;
    });
  }

  function toggleAvailableSelection(patternId: string) {
    setSelectedAvailableIds((current) => {
      const next = new Set(current);
      if (next.has(patternId)) {
        next.delete(patternId);
      } else {
        next.add(patternId);
      }
      return next;
    });
  }

  function toggleInProgressSelection(patternId: string) {
    setSelectedInProgressIds((current) => {
      const next = new Set(current);
      if (next.has(patternId)) {
        next.delete(patternId);
      } else {
        next.add(patternId);
      }
      return next;
    });
  }

  return (
    <main className="min-h-screen bg-slate-50 text-slate-950">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-3 border-b border-slate-200 pb-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex flex-wrap gap-3 text-sm font-medium">
              <Link href="/projects" prefetch={false} className="text-slate-500 hover:text-slate-900">返回项目列表</Link>
            </div>
            {isRenamingProject ? (
              <form className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center" onSubmit={handleRenameProject}>
                <input
                  value={renameDraft}
                  onChange={(event) => setRenameDraft(event.target.value)}
                  className="h-11 min-w-0 rounded border border-slate-300 px-3 text-xl font-semibold outline-none focus:border-blue-500 sm:w-80"
                  autoFocus
                />
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={busyAction === 'rename-project' || !renameDraft.trim()}
                    className="inline-flex h-10 items-center justify-center rounded bg-slate-950 px-4 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {busyAction === 'rename-project' ? '保存中' : '保存'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setIsRenamingProject(false);
                      setRenameDraft('');
                    }}
                    className="inline-flex h-10 items-center justify-center rounded border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-100"
                  >
                    取消
                  </button>
                </div>
              </form>
            ) : (
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <h1 className="text-2xl font-semibold tracking-normal">{project.name}</h1>
                <button
                  type="button"
                  onClick={() => {
                    setRenameDraft(project.name);
                    setIsRenamingProject(true);
                  }}
                  className="inline-flex h-8 w-8 items-center justify-center rounded border border-slate-200 bg-white text-slate-500 hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900"
                  aria-label="修改项目名称"
                  title="修改项目名称"
                >
                  <span aria-hidden="true">✎</span>
                </button>
                <StatusText status={project.status} />
              </div>
            )}
            <p className="mt-1 text-sm text-slate-500">
              {project.warehouseName} · {project.warehouseBrand || 'MARD'} {project.warehousePaletteName || ''} · 锁定于 {formatDateTime(project.warehouseLockedAt)}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/analysis"
              prefetch={false}
              className="inline-flex h-10 items-center justify-center rounded bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700"
            >
              加载图纸
            </Link>
            <Link
              href="/warehouse"
              prefetch={false}
              className="inline-flex h-10 items-center justify-center rounded border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-100"
            >
              查看豆仓
            </Link>
          </div>
        </header>

        {(message || error) && (
          <div className={`rounded border px-4 py-3 text-sm ${error ? 'border-red-200 bg-red-50 text-red-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}>
            {error || message}
          </div>
        )}

        <section className="grid grid-cols-2 gap-2 text-center text-sm sm:grid-cols-5">
          <Stat label="总需求" value={String(project.summary.totalNeeded)} />
          <Stat label="库存覆盖" value={String(project.summary.totalOwned)} />
          <Stat
            label="缺豆"
            value={String(project.summary.totalMissing)}
            tone={project.summary.totalMissing > 0 ? 'warn' : 'ok'}
            onClick={() => document.getElementById('project-missing-details')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          />
          <Stat label="缺色" value={String(project.summary.missingColorCount)} tone={project.summary.missingColorCount > 0 ? 'warn' : 'ok'} />
          <Stat label="图纸" value={String(project.patterns.length)} />
        </section>

        <section className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
          <section className="flex flex-col gap-4">
            <AvailablePatternSection
              patterns={project.availablePatterns}
              viewMode={availableViewMode}
              onViewModeChange={setAvailableViewMode}
              selectedIds={selectedAvailableIds}
              busyAction={busyAction}
              onToggleSelect={toggleAvailableSelection}
              onAdd={addAvailableSelection}
            />
            <DraftPatternSection
              patterns={groupedPatterns.draft}
              details={project.patternDetails}
              viewMode={draftViewMode}
              onViewModeChange={setDraftViewMode}
              selectedIds={selectedDraftIds}
              activePreviewId={activePreviewPattern?.id ?? ''}
              busyAction={busyAction}
              onToggleSelect={toggleDraftSelection}
              onPreviewSelect={setActivePreviewId}
              onMove={(status) => movePatternSelection({
                patternIds: selectedDraftIds,
                status,
                actionKey: `move-draft-${status}`,
                clearSelection: () => setSelectedDraftIds(new Set()),
              })}
              onRemove={removeDraftSelection}
              projectId={project.id}
            />
            <InProgressPatternSection
              patterns={groupedPatterns.in_progress}
              details={project.patternDetails}
              selectedIds={selectedInProgressIds}
              busyAction={busyAction}
              onToggleSelect={toggleInProgressSelection}
              onMoveBack={() => movePatternSelection({
                patternIds: selectedInProgressIds,
                status: 'draft',
                actionKey: 'move-in-progress-draft',
                clearSelection: () => setSelectedInProgressIds(new Set()),
              })}
            />
            <PatternSection title="已完成" status="completed" patterns={groupedPatterns.completed} details={project.patternDetails} />
          </section>

          <section className="flex flex-col gap-4">
            <RequirementTable
              id="project-missing-details"
              title="缺豆明细"
              emptyText="当前没有缺豆"
              items={missingItems}
              mode="missing"
              sourceLabel={requirementSourceLabel}
            />
            <RequirementTable
              title="当前计划需求"
              emptyText="还没有未完成图纸。添加图纸后会在这里显示需求。"
              items={requirementItems}
              mode="all"
              sourceLabel={requirementSourceLabel}
            />
          </section>
        </section>

        <DangerZone
          projectName={project.name}
          confirmName={deleteConfirmName}
          busyAction={busyAction}
          onConfirmNameChange={setDeleteConfirmName}
          onDelete={deleteCurrentProject}
        />
      </div>
    </main>
  );
}

function AvailablePatternSection({
  patterns,
  viewMode,
  onViewModeChange,
  selectedIds,
  busyAction,
  onToggleSelect,
  onAdd,
}: {
  patterns: AvailablePattern[];
  viewMode: DraftViewMode;
  onViewModeChange: (mode: DraftViewMode) => void;
  selectedIds: Set<string>;
  busyAction: string;
  onToggleSelect: (patternId: string) => void;
  onAdd: () => void;
}) {
  const allSelected = patterns.length > 0 && patterns.every((pattern) => selectedIds.has(pattern.id));

  return (
    <section className="rounded border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-base font-semibold">可用图纸</h2>
          <p className="mt-1 text-sm text-slate-500">来自 batch 分析 JSON，未被其他项目占用。添加后会进入当前项目草稿。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <div className="inline-flex rounded border border-slate-300 bg-white p-1 text-sm">
            <button
              type="button"
              onClick={() => onViewModeChange('list')}
              className={`h-8 rounded px-3 ${viewMode === 'list' ? 'bg-slate-950 text-white' : 'text-slate-600 hover:bg-slate-50'}`}
            >
              list
            </button>
            <button
              type="button"
              onClick={() => onViewModeChange('thumbnail')}
              className={`h-8 rounded px-3 ${viewMode === 'thumbnail' ? 'bg-slate-950 text-white' : 'text-slate-600 hover:bg-slate-50'}`}
            >
              缩略图
            </button>
          </div>
          <button
            type="button"
            disabled={selectedIds.size === 0 || Boolean(busyAction)}
            onClick={onAdd}
            className="inline-flex h-10 items-center justify-center rounded bg-slate-950 px-3 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busyAction === 'add-available-patterns' ? '添加中...' : `添加 ${selectedIds.size} 张`}
          </button>
        </div>
      </div>

      {patterns.length === 0 ? (
        <div className="mt-3 rounded border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
          暂无可用图纸
        </div>
      ) : viewMode === 'list' ? (
        <div className="mt-3 overflow-auto rounded border border-slate-100">
          <table className="w-full min-w-[760px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-slate-500">
                <th className="px-3 py-2">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={() => {
                      if (allSelected) {
                        patterns.forEach((pattern) => selectedIds.has(pattern.id) && onToggleSelect(pattern.id));
                      } else {
                        patterns.forEach((pattern) => !selectedIds.has(pattern.id) && onToggleSelect(pattern.id));
                      }
                    }}
                    className="h-4 w-4"
                    aria-label="选择全部可用图纸"
                  />
                </th>
                <th className="px-3 py-2">缩略图</th>
                <th className="px-3 py-2">名称</th>
                <th className="px-3 py-2">类型</th>
                <th className="px-3 py-2 text-right">豆数</th>
                <th className="px-3 py-2 text-right">颜色</th>
                <th className="px-3 py-2">状态</th>
              </tr>
            </thead>
            <tbody>
              {patterns.map((pattern) => (
                <tr key={pattern.id} className="border-b border-slate-100 last:border-b-0">
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(pattern.id)}
                      onChange={() => onToggleSelect(pattern.id)}
                      className="h-4 w-4"
                      aria-label={`选择 ${pattern.name}`}
                    />
                  </td>
                  <td className="px-3 py-2"><PatternThumbnail path={pattern.thumbnailPath} size="sm" /></td>
                  <td className="px-3 py-2 font-medium">{pattern.name}</td>
                  <td className="px-3 py-2 text-slate-600">{pattern.isGrouped ? '组图' : '单图'}</td>
                  <td className="px-3 py-2 text-right">{pattern.totalBeadCount}</td>
                  <td className="px-3 py-2 text-right">{pattern.colorCount}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">
                    {pattern.matchesExpected === false ? '需核对' : pattern.analysisStatus || '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
          {patterns.map((pattern) => (
            <button
              key={pattern.id}
              type="button"
              onClick={() => onToggleSelect(pattern.id)}
              className={`flex aspect-square min-w-0 flex-col rounded border bg-white p-2 transition hover:bg-slate-50 ${selectedIds.has(pattern.id) ? 'border-slate-950 ring-1 ring-slate-950' : 'border-slate-200'}`}
            >
              <div className="min-h-0 w-full flex-1">
                <PatternThumbnail path={pattern.thumbnailPath} size="tile" />
              </div>
              <div className="mt-2 h-5 w-full truncate text-center text-xs font-semibold">{pattern.name}</div>
              <div className="text-center text-[11px] text-slate-500">{pattern.totalBeadCount} 颗 · {pattern.colorCount} 色</div>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function DraftPatternSection({
  patterns,
  details,
  viewMode,
  onViewModeChange,
  selectedIds,
  activePreviewId,
  busyAction,
  onToggleSelect,
  onPreviewSelect,
  onMove,
  onRemove,
  projectId,
}: {
  patterns: ProjectPattern[];
  details: Record<string, ProjectPatternDetail>;
  viewMode: DraftViewMode;
  onViewModeChange: (mode: DraftViewMode) => void;
  selectedIds: Set<string>;
  activePreviewId: string;
  busyAction: string;
  onToggleSelect: (patternId: string) => void;
  onPreviewSelect: (patternId: string) => void;
  onMove: (status: Extract<ProjectStatus, 'in_progress' | 'completed'>) => void;
  onRemove: () => void;
  projectId: string;
}) {
  const activePattern = patterns.find((pattern) => pattern.id === activePreviewId) ?? null;
  const activeDetail = activePattern ? details[activePattern.id] : null;
  const allSelected = patterns.length > 0 && patterns.every((pattern) => selectedIds.has(pattern.id));

  return (
    <section className="rounded border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-base font-semibold">草稿</h2>
          <p className="mt-1 text-sm text-slate-500">草稿图纸可以先预览需求，也可以批量移动到进行中或已完成。</p>
        </div>
        <div className="inline-flex rounded border border-slate-300 bg-white p-1 text-sm">
          <button
            type="button"
            onClick={() => onViewModeChange('list')}
            className={`h-8 rounded px-3 ${viewMode === 'list' ? 'bg-slate-950 text-white' : 'text-slate-600 hover:bg-slate-50'}`}
          >
            list
          </button>
          <button
            type="button"
            onClick={() => onViewModeChange('thumbnail')}
            className={`h-8 rounded px-3 ${viewMode === 'thumbnail' ? 'bg-slate-950 text-white' : 'text-slate-600 hover:bg-slate-50'}`}
          >
            缩略图
          </button>
        </div>
      </div>

      {patterns.length === 0 ? (
        <div className="mt-3 rounded border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
          暂无草稿图纸
        </div>
      ) : viewMode === 'list' ? (
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex flex-col gap-2 rounded border border-slate-200 bg-slate-50 p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
            <label className="inline-flex items-center gap-2 font-medium text-slate-700">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={() => {
                  if (allSelected) {
                    patterns.forEach((pattern) => selectedIds.has(pattern.id) && onToggleSelect(pattern.id));
                  } else {
                    patterns.forEach((pattern) => !selectedIds.has(pattern.id) && onToggleSelect(pattern.id));
                  }
                }}
                className="h-4 w-4"
              />
              已选择 {selectedIds.size} / {patterns.length}
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={selectedIds.size === 0 || Boolean(busyAction)}
                onClick={() => onMove('in_progress')}
                className="inline-flex h-9 items-center justify-center rounded bg-blue-600 px-3 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busyAction === 'move-draft-in_progress' ? '移动中...' : '移动到进行中'}
              </button>
              <button
                type="button"
                disabled={selectedIds.size === 0 || Boolean(busyAction)}
                onClick={() => onMove('completed')}
                className="inline-flex h-9 items-center justify-center rounded bg-emerald-600 px-3 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busyAction === 'move-draft-completed' ? '移动中...' : '移动到已完成'}
              </button>
              <button
                type="button"
                disabled={selectedIds.size === 0 || Boolean(busyAction)}
                onClick={onRemove}
                className="inline-flex h-9 items-center justify-center rounded border border-red-200 bg-white px-3 text-sm font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busyAction === 'remove-draft-patterns' ? '移除中...' : '从项目移除'}
              </button>
            </div>
          </div>
          <div className="overflow-auto rounded border border-slate-100">
            <table className="w-full min-w-[760px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-slate-500">
                  <th className="px-3 py-2">选择</th>
                  <th className="px-3 py-2">缩略图</th>
                  <th className="px-3 py-2">名称</th>
                  <th className="px-3 py-2">尺寸</th>
                  <th className="px-3 py-2 text-right">豆数</th>
                  <th className="px-3 py-2 text-right">颜色</th>
                  <th className="px-3 py-2">文件</th>
                </tr>
              </thead>
              <tbody>
                {patterns.map((pattern) => (
                  <tr key={pattern.id} className="border-b border-slate-100 last:border-b-0">
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(pattern.id)}
                        onChange={() => onToggleSelect(pattern.id)}
                        className="h-4 w-4"
                        aria-label={`选择 ${pattern.name}`}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <PatternVisual pattern={pattern} detail={details[pattern.id]} size="sm" />
                    </td>
                    <td className="px-3 py-2 font-medium">{pattern.name}</td>
                    <td className="px-3 py-2 text-slate-600">{formatDimensions(pattern)}</td>
                    <td className="px-3 py-2 text-right">{pattern.totalBeadCount}</td>
                    <td className="px-3 py-2 text-right">{pattern.colorCount}</td>
                    <td className="px-3 py-2">
                      <span className="block max-w-[260px] truncate text-xs text-slate-500">
                        {pattern.fileName || pattern.path || '-'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className={`mt-3 grid gap-4 ${activePattern && activeDetail ? 'lg:grid-cols-[minmax(0,1fr)_320px]' : ''}`}>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
            {patterns.map((pattern) => (
              <button
                key={pattern.id}
                type="button"
                onClick={() => onPreviewSelect(pattern.id)}
                className={`flex aspect-square min-w-0 flex-col rounded border bg-white p-2 transition hover:bg-slate-50 ${activePattern?.id === pattern.id ? 'border-slate-950 ring-1 ring-slate-950' : 'border-slate-200'}`}
              >
                <div className="min-h-0 w-full flex-1">
                  <PatternVisual pattern={pattern} detail={details[pattern.id]} size="tile" />
                </div>
                <div className="mt-2 h-5 w-full truncate text-center text-xs font-semibold">{pattern.name}</div>
              </button>
            ))}
          </div>
          {activePattern && activeDetail && (
            <aside className="rounded border border-slate-200 bg-slate-50 p-3">
              <div className="flex flex-col gap-3">
                <div>
                  <div className="text-sm font-semibold">{activePattern.name}</div>
                  <div className="mt-1 text-xs text-slate-500">{activeDetail.sourcePath || activePattern.fileName || activePattern.path}</div>
                </div>
                <PatternVisual pattern={activePattern} detail={activeDetail} size="lg" />
                <div>
                  <div className="text-sm font-semibold">需要颜色</div>
                  <div className="mt-2 grid max-h-52 grid-cols-2 gap-2 overflow-auto text-sm">
                    {activeDetail.colors.map((color) => (
                      <div key={`${color.hex}-${color.colorKey}`} className="flex items-center justify-between rounded border border-slate-200 bg-white px-2 py-1">
                        <span className="font-semibold">{color.colorKey}</span>
                        <span className="text-slate-600">{color.count}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <Link
                  href={`/analysis?mode=edit&projectId=${encodeURIComponent(projectId)}&patternId=${encodeURIComponent(activePattern.id)}&patternPath=${encodeURIComponent(activeDetail.sourcePath || activePattern.path || '')}`}
                  className="inline-flex h-9 items-center justify-center rounded bg-slate-950 px-3 text-sm font-medium text-white hover:bg-slate-800"
                >
                  编辑
                </Link>
              </div>
            </aside>
          )}
        </div>
      )}
    </section>
  );
}

function InProgressPatternSection({
  patterns,
  details,
  selectedIds,
  busyAction,
  onToggleSelect,
  onMoveBack,
}: {
  patterns: ProjectPattern[];
  details: Record<string, ProjectPatternDetail>;
  selectedIds: Set<string>;
  busyAction: string;
  onToggleSelect: (patternId: string) => void;
  onMoveBack: () => void;
}) {
  const allSelected = patterns.length > 0 && patterns.every((pattern) => selectedIds.has(pattern.id));

  return (
    <section className="rounded border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-base font-semibold">进行中</h2>
          <p className="mt-1 text-sm text-slate-500">进行中的图纸可以多选后移回计划。</p>
        </div>
        <span className="text-sm text-slate-500">{patterns.length} 张</span>
      </div>

      <div className="mt-3 flex flex-col gap-3">
        <div className="flex flex-col gap-2 rounded border border-slate-200 bg-slate-50 p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          <label className="inline-flex items-center gap-2 font-medium text-slate-700">
            <input
              type="checkbox"
              checked={allSelected}
              disabled={patterns.length === 0}
              onChange={() => {
                if (allSelected) {
                  patterns.forEach((pattern) => selectedIds.has(pattern.id) && onToggleSelect(pattern.id));
                } else {
                  patterns.forEach((pattern) => !selectedIds.has(pattern.id) && onToggleSelect(pattern.id));
                }
              }}
              className="h-4 w-4"
            />
            已选择 {selectedIds.size} / {patterns.length}
          </label>
          <button
            type="button"
            disabled={selectedIds.size === 0 || Boolean(busyAction)}
            onClick={onMoveBack}
            className="inline-flex h-9 items-center justify-center rounded bg-slate-950 px-3 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busyAction === 'move-in-progress-draft' ? '移动中...' : '移回计划'}
          </button>
        </div>

        <div className="overflow-auto rounded border border-slate-100">
          <table className="w-full min-w-[760px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-slate-500">
                <th className="px-3 py-2">选择</th>
                <th className="px-3 py-2">缩略图</th>
                <th className="px-3 py-2">名称</th>
                <th className="px-3 py-2">尺寸</th>
                <th className="px-3 py-2 text-right">豆数</th>
                <th className="px-3 py-2 text-right">颜色</th>
                <th className="px-3 py-2">文件</th>
              </tr>
            </thead>
            <tbody>
              {patterns.length === 0 ? (
                <tr>
                  <td className="px-3 py-4 text-center text-slate-500" colSpan={7}>
                    暂无进行中图纸
                  </td>
                </tr>
              ) : (
                patterns.map((pattern) => (
                  <tr key={pattern.id} className="border-b border-slate-100 last:border-b-0">
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(pattern.id)}
                        onChange={() => onToggleSelect(pattern.id)}
                        className="h-4 w-4"
                        aria-label={`选择 ${pattern.name}`}
                      />
                    </td>
                    <td className="px-3 py-2"><PatternVisual pattern={pattern} detail={details[pattern.id]} size="sm" /></td>
                    <td className="px-3 py-2 font-medium">{pattern.name}</td>
                    <td className="px-3 py-2 text-slate-600">{formatDimensions(pattern)}</td>
                    <td className="px-3 py-2 text-right">{pattern.totalBeadCount}</td>
                    <td className="px-3 py-2 text-right">{pattern.colorCount}</td>
                    <td className="px-3 py-2">
                      <span className="block max-w-[260px] truncate text-xs text-slate-500">
                        {pattern.fileName || pattern.path || '-'}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function PatternSection({
  title,
  status,
  patterns,
  details,
}: {
  title: string;
  status: ProjectStatus;
  patterns: ProjectPattern[];
  details: Record<string, ProjectPatternDetail>;
}) {
  return (
    <section className="rounded border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold">{title}</h2>
        <span className="text-sm text-slate-500">{patterns.length} 张</span>
      </div>
      <div className="mt-3 overflow-auto rounded border border-slate-100">
        <table className="w-full min-w-[700px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-slate-500">
              <th className="px-3 py-2">缩略图</th>
              <th className="px-3 py-2">名称</th>
              <th className="px-3 py-2">尺寸</th>
              <th className="px-3 py-2 text-right">豆数</th>
              <th className="px-3 py-2 text-right">颜色</th>
              <th className="px-3 py-2">文件</th>
            </tr>
          </thead>
          <tbody>
            {patterns.length === 0 ? (
              <tr>
                <td className="px-3 py-4 text-center text-slate-500" colSpan={6}>
                  暂无{statusLabel(status)}图纸
                </td>
              </tr>
            ) : (
              patterns.map((pattern) => (
                <tr key={pattern.id} className="border-b border-slate-100 last:border-b-0">
                  <td className="px-3 py-2"><PatternVisual pattern={pattern} detail={details[pattern.id]} size="sm" /></td>
                  <td className="px-3 py-2 font-medium">{pattern.name}</td>
                  <td className="px-3 py-2 text-slate-600">{formatDimensions(pattern)}</td>
                  <td className="px-3 py-2 text-right">{pattern.totalBeadCount}</td>
                  <td className="px-3 py-2 text-right">{pattern.colorCount}</td>
                  <td className="px-3 py-2">
                    <span className="block max-w-[260px] truncate text-xs text-slate-500">
                      {pattern.fileName || pattern.path || '-'}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DangerZone({
  projectName,
  confirmName,
  busyAction,
  onConfirmNameChange,
  onDelete,
}: {
  projectName: string;
  confirmName: string;
  busyAction: string;
  onConfirmNameChange: (value: string) => void;
  onDelete: () => void;
}) {
  return (
    <section className="rounded border border-red-200 bg-white p-4 shadow-sm">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 className="text-base font-semibold text-red-700">删除项目</h2>
          <p className="mt-1 text-sm text-slate-500">
            删除后会移除项目目录，并释放这个项目占用的图纸。请输入项目名确认。
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <label className="text-sm">
            <span className="font-medium text-slate-700">项目名</span>
            <input
              value={confirmName}
              onChange={(event) => onConfirmNameChange(event.target.value)}
              className="mt-1 h-10 w-full rounded border border-slate-300 px-3 text-sm outline-none focus:border-red-500 sm:w-72"
              placeholder={projectName}
            />
          </label>
          <button
            type="button"
            disabled={busyAction === 'delete-project' || confirmName !== projectName}
            onClick={onDelete}
            className="inline-flex h-10 items-center justify-center rounded bg-red-600 px-4 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busyAction === 'delete-project' ? '删除中...' : '删除项目'}
          </button>
        </div>
      </div>
    </section>
  );
}

function PatternVisual({
  pattern,
  detail,
  size,
}: {
  pattern: ProjectPattern;
  detail?: ProjectPatternDetail;
  size: 'sm' | 'tile' | 'md' | 'lg';
}) {
  if (pattern.thumbnailPath) {
    return <PatternThumbnail path={pattern.thumbnailPath} size={size} />;
  }
  return <PatternMosaic detail={detail} size={size} />;
}

function PatternThumbnail({ path, size }: { path?: string; size: 'sm' | 'tile' | 'md' | 'lg' }) {
  const className = size === 'sm'
    ? 'h-14 w-14'
    : size === 'tile'
      ? 'h-full w-full'
      : size === 'md'
        ? 'aspect-square w-full'
        : 'aspect-square w-full max-w-[260px]';

  if (!path) {
    return <div className={`${className} rounded border border-dashed border-slate-300 bg-slate-100`} />;
  }

  return (
    <img
      src={`/api/projects/pattern-image?path=${encodeURIComponent(path)}`}
      alt=""
      className={`${className} rounded border border-slate-300 bg-white object-contain`}
      loading="lazy"
    />
  );
}

function PatternMosaic({ detail, size }: { detail?: ProjectPatternDetail; size: 'sm' | 'tile' | 'md' | 'lg' }) {
  const rows = detail?.previewRows ?? [];
  const className = size === 'sm'
    ? 'h-14 w-14'
    : size === 'tile'
      ? 'h-full w-full'
      : size === 'md'
        ? 'aspect-square w-full'
        : 'aspect-square w-full max-w-[260px]';

  if (rows.length === 0) {
    return (
      <div className={`${className} rounded border border-dashed border-slate-300 bg-slate-100`} />
    );
  }

  const columnCount = Math.max(...rows.map((row) => row.length), 1);
  return (
    <div
      className={`${className} overflow-hidden rounded border border-slate-300 bg-white`}
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
      }}
    >
      {rows.flatMap((row, rowIndex) => (
        row.map((cell, colIndex) => (
          <span
            key={`${rowIndex}-${colIndex}`}
            title={cell.colorKey}
            style={{ backgroundColor: cell.color }}
          />
        ))
      ))}
    </div>
  );
}

function RequirementTable({
  id,
  title,
  emptyText,
  items,
  mode,
  sourceLabel,
}: {
  id?: string;
  title: string;
  emptyText: string;
  items: ProjectRequirementItem[];
  mode: 'missing' | 'all';
  sourceLabel: string;
}) {
  if (mode === 'missing') {
    return (
      <MissingRequirementList
        id={id}
        title={title}
        emptyText={emptyText}
        items={items}
        sourceLabel={sourceLabel}
      />
    );
  }

  return (
    <section id={id} className="rounded border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="mt-1 text-xs text-slate-500">{`来源：${sourceLabel}`}</p>
        </div>
        <span className="text-sm text-slate-500">{items.length} 色</span>
      </div>
      <div className="mt-3 overflow-auto rounded border border-slate-100">
        <table className="w-full min-w-[560px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-slate-500">
              <th className="px-3 py-2">色号</th>
              <th className="px-3 py-2">颜色</th>
              <th className="px-3 py-2 text-right">需要</th>
              <th className="px-3 py-2 text-right">库存</th>
              <th className="px-3 py-2 text-right">完成后</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td className="px-3 py-4 text-center text-slate-500" colSpan={5}>{emptyText}</td>
              </tr>
            ) : (
              items.map((item) => (
                <tr key={`${item.hex}-${item.colorKey}`} className="border-b border-slate-100 last:border-b-0">
                  <td className="px-3 py-2 font-semibold">{item.colorKey}</td>
                  <td className="px-3 py-2">
                    <span className="inline-flex items-center gap-2">
                      <span className="h-6 w-6 rounded border border-slate-300" style={{ backgroundColor: item.hex }} />
                      <span className="text-xs text-slate-500">{formatHexWithoutHash(item.hex)}</span>
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">{item.needed}</td>
                  <td className="px-3 py-2 text-right">{item.owned}</td>
                  <td className={`px-3 py-2 text-right font-semibold ${item.missing > 0 ? 'text-red-600' : 'text-slate-700'}`}>
                    {item.remainingAfterProject}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function MissingRequirementList({
  id,
  title,
  emptyText,
  items,
  sourceLabel,
}: {
  id?: string;
  title: string;
  emptyText: string;
  items: ProjectRequirementItem[];
  sourceLabel: string;
}) {
  return (
    <section id={id} className="rounded border border-slate-200 bg-white p-4 shadow-sm scroll-mt-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="mt-1 text-xs text-slate-500">{`来源：${sourceLabel}`}</p>
        </div>
        <span className="text-sm text-slate-500">{items.length} 色</span>
      </div>
      {items.length === 0 ? (
        <div className="mt-3 rounded border border-dashed border-slate-300 p-4 text-center text-sm text-slate-500">
          {emptyText}
        </div>
      ) : (
        <div className="mt-3 max-h-[472px] overflow-y-auto pr-1">
          <div className="grid grid-cols-2 gap-2">
          {items.map((item) => (
            <div key={`${item.hex}-${item.colorKey}`} className="flex min-h-10 items-center justify-between gap-2 rounded border border-slate-200 bg-white px-2.5 py-1.5">
              <span className="inline-flex min-w-0 items-center gap-2">
                <span className="h-5 w-5 shrink-0 rounded border border-slate-300" style={{ backgroundColor: item.hex }} />
                <span className="truncate text-sm font-semibold text-slate-950">{item.colorKey || '未命名'}</span>
              </span>
              <span className="whitespace-nowrap text-sm font-semibold text-red-700">
                缺 <span className="text-base">{item.missing}</span> 颗
              </span>
            </div>
          ))}
          </div>
        </div>
      )}
    </section>
  );
}

function Stat({
  label,
  value,
  tone,
  active,
  onClick,
}: {
  label: string;
  value: string;
  tone?: 'ok' | 'warn';
  active?: boolean;
  onClick?: () => void;
}) {
  const toneClass = tone === 'warn' ? 'text-red-700' : tone === 'ok' ? 'text-emerald-700' : 'text-slate-950';
  const className = `rounded border px-3 py-2 shadow-sm ${active ? 'border-red-300 bg-red-50' : 'border-slate-200 bg-white'}`;
  const content = (
    <>
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`mt-1 font-semibold ${toneClass}`}>{value}</div>
    </>
  );
  if (onClick) {
    return (
      <button type="button" className={`${className} text-center hover:border-slate-300 hover:bg-slate-50`} onClick={onClick}>
        {content}
      </button>
    );
  }
  return (
    <div className={className}>
      {content}
    </div>
  );
}

function StatusText({ status }: { status: ProjectStatus }) {
  return (
    <span className="text-sm font-medium text-slate-500">
      {statusLabel(status)}
    </span>
  );
}

function statusLabel(status: ProjectStatus): string {
  switch (status) {
    case 'in_progress':
      return '进行中';
    case 'completed':
      return '已完成';
    default:
      return '草稿';
  }
}

function formatDimensions(pattern: ProjectPattern): string {
  return pattern.gridDimensions ? `${pattern.gridDimensions.N}x${pattern.gridDimensions.M}` : '-';
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}

function formatHexWithoutHash(hex: string): string {
  return String(hex || '').replace(/^#/, '').toUpperCase();
}

function formatRequirementSourceLabel(patterns: ProjectPattern[]): string {
  const names = Array.from(new Set(patterns.map(formatPatternSourceName).filter(Boolean)));
  if (names.length === 0) return '当前无图纸';
  if (names.length <= 3) return names.join('、');
  return `${names.slice(0, 3).join('、')} 等 ${names.length} 张`;
}

function formatPatternSourceName(pattern: ProjectPattern): string {
  const sourceName = pattern.name || pattern.fileName || pattern.path || '';
  return sourceName
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.grid\.json$/i, '')
    .replace(/\.[^.]+$/i, '')
    || '未命名图纸';
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
