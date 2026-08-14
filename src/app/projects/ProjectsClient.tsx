'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormEvent, useMemo, useState } from 'react';
import type { ProjectFile, ProjectListItem, ProjectWarehouseOption } from '../api/projects/_projectStore';

interface ProjectsClientProps {
  initialProjects: ProjectListItem[];
  warehouses: ProjectWarehouseOption[];
}

interface ApiResponse {
  ok: boolean;
  error?: string;
  project?: ProjectFile;
}

export default function ProjectsClient({ initialProjects, warehouses }: ProjectsClientProps) {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectListItem[]>(initialProjects);
  const [isCreateOpen, setIsCreateOpen] = useState(initialProjects.length === 0);
  const [form, setForm] = useState({
    name: '',
    warehouseId: warehouses[0]?.id ?? '',
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const selectedWarehouse = useMemo(
    () => warehouses.find((warehouse) => warehouse.id === form.warehouseId),
    [warehouses, form.warehouseId]
  );

  async function handleCreateProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setMessage('');
    setError('');

    try {
      const response = await fetch('/api/projects/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const payload = (await response.json()) as ApiResponse;
      if (!response.ok || !payload.ok || !payload.project) {
        throw new Error(payload.error || '创建项目失败');
      }
      const project = payload.project;

      setProjects((current) => [projectToListItem(project), ...current]);
      setMessage(`已创建项目：${project.name}`);
      router.push(`/projects/${encodeURIComponent(project.id)}`);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : '创建项目失败');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen bg-slate-50 text-slate-950">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-3 border-b border-slate-200 pb-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <Link href="/" className="text-sm font-medium text-slate-500 hover:text-slate-900">返回主页</Link>
            <h1 className="mt-1 text-2xl font-semibold tracking-normal">加载项目</h1>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setIsCreateOpen((current) => !current)}
              className="inline-flex h-10 items-center justify-center rounded bg-slate-950 px-4 text-sm font-medium text-white hover:bg-slate-800"
            >
              {isCreateOpen ? '收起新建' : '新建项目'}
            </button>
            <Link
              href="/analysis"
              className="inline-flex h-10 items-center justify-center rounded bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700"
            >
              加载图纸
            </Link>
            <Link
              href="/warehouse"
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

        {isCreateOpen && (
          <section className="rounded border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 className="text-base font-semibold">新建项目</h2>
                <p className="mt-1 text-sm text-slate-500">项目建立后会锁定绑定豆仓；需要换豆仓时请新建另一个项目。</p>
              </div>
              {selectedWarehouse && (
                <span className="rounded border border-slate-200 bg-slate-50 px-3 py-1 text-sm text-slate-600">
                  {selectedWarehouse.brand} {selectedWarehouse.paletteName}
                </span>
              )}
            </div>

            {warehouses.length === 0 ? (
              <EmptyState text="还没有豆仓。先去豆仓页面创建一个豆仓，再回来新建项目。" actionHref="/warehouse" actionText="去创建豆仓" />
            ) : (
              <form className="mt-4 grid gap-3 md:grid-cols-[1fr_260px_auto]" onSubmit={handleCreateProject}>
                <label className="text-sm">
                  <span className="font-medium text-slate-700">项目名称</span>
                  <input
                    value={form.name}
                    onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                    className="mt-1 h-10 w-full rounded border border-slate-300 px-3 text-sm outline-none focus:border-blue-500"
                    placeholder="例如：卡比项目"
                  />
                </label>
                <label className="text-sm">
                  <span className="font-medium text-slate-700">绑定豆仓</span>
                  <select
                    value={form.warehouseId}
                    onChange={(event) => setForm((current) => ({ ...current, warehouseId: event.target.value }))}
                    className="mt-1 h-10 w-full rounded border border-slate-300 px-3 text-sm outline-none focus:border-blue-500"
                  >
                    {warehouses.map((warehouse) => (
                      <option key={warehouse.id} value={warehouse.id}>
                        {warehouse.name} · {warehouse.brand} {warehouse.paletteName}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="submit"
                  disabled={isSubmitting || !form.name.trim() || !form.warehouseId}
                  className="mt-6 inline-flex h-10 items-center justify-center rounded bg-slate-950 px-4 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60 md:mt-[26px]"
                >
                  {isSubmitting ? '创建中...' : '创建并进入'}
                </button>
              </form>
            )}
          </section>
        )}

        {projects.length === 0 ? (
          <EmptyState text="还没有项目。可以先新建一个空项目，或继续用 calc:project 脚本从 .grid.json 创建项目。" />
        ) : (
          <section className="grid gap-4 lg:grid-cols-2">
            {projects.map((project) => (
              <article key={project.id} className="rounded border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <Link
                      href={`/projects/${encodeURIComponent(project.id)}`}
                      className="text-lg font-semibold text-slate-950 hover:text-blue-700"
                    >
                      {project.name}
                    </Link>
                    <p className="mt-1 text-sm text-slate-500">
                      {project.warehouseName} · {project.warehouseBrand || 'MARD'} {project.warehousePaletteName || ''} · {project.patternCount} 张图纸
                    </p>
                  </div>
                  <span className="rounded border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-600">
                    {statusLabel(project.status)}
                  </span>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-2 text-center text-sm sm:grid-cols-4">
                  <Stat label="总需求" value={String(project.totalNeeded)} />
                  <Stat label="缺豆" value={String(project.totalMissing)} tone={project.totalMissing > 0 ? 'warn' : 'ok'} />
                  <Stat label="缺色" value={String(project.missingColorCount)} tone={project.missingColorCount > 0 ? 'warn' : 'ok'} />
                  <Stat label="图纸" value={String(project.patternCount)} />
                </div>

                <div className="mt-4 flex flex-col gap-2 text-sm text-slate-500 sm:flex-row sm:items-center sm:justify-between">
                  <span>更新于 {formatDateTime(project.updatedAt)}</span>
                  <Link
                    href={`/projects/${encodeURIComponent(project.id)}`}
                    className="inline-flex h-9 items-center justify-center rounded border border-slate-300 bg-white px-3 font-medium text-slate-700 hover:bg-slate-50"
                  >
                    打开工作台
                  </Link>
                </div>
              </article>
            ))}
          </section>
        )}
      </div>
    </main>
  );
}

function projectToListItem(project: ProjectFile): ProjectListItem {
  return {
    id: project.id,
    name: project.name,
    updatedAt: project.updatedAt,
    warehouseId: project.warehouseId,
    warehouseName: project.warehouseName,
    warehouseBrand: project.warehouseBrand,
    warehousePaletteName: project.warehousePaletteName,
    status: project.status,
    patternCount: project.patterns.length,
    totalBeadCount: project.patterns.reduce((sum, pattern) => sum + Number(pattern.totalBeadCount || 0), 0),
    totalNeeded: project.summary.totalNeeded,
    totalMissing: project.summary.totalMissing,
    missingColorCount: project.summary.missingColorCount,
    thumbnailPath: project.patterns.find((pattern) => pattern.thumbnailPath)?.thumbnailPath,
  };
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' }) {
  const toneClass = tone === 'warn' ? 'text-red-700' : tone === 'ok' ? 'text-emerald-700' : 'text-slate-950';
  return (
    <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`mt-1 font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
}

function EmptyState({ text, actionHref, actionText }: { text: string; actionHref?: string; actionText?: string }) {
  return (
    <div className="rounded border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
      <div>{text}</div>
      {actionHref && actionText && (
        <Link
          href={actionHref}
          className="mt-4 inline-flex h-9 items-center justify-center rounded bg-slate-950 px-3 text-sm font-medium text-white hover:bg-slate-800"
        >
          {actionText}
        </Link>
      )}
    </div>
  );
}

function statusLabel(status: ProjectListItem['status']): string {
  switch (status) {
    case 'in_progress':
      return '进行中';
    case 'completed':
      return '已完成';
    default:
      return '草稿';
  }
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}
