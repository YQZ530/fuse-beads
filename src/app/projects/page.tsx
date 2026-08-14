import Link from 'next/link';
import { readdir, readFile } from 'fs/promises';
import path from 'path';

interface ProjectFile {
  id: string;
  name: string;
  warehouseId: string;
  warehouseName: string;
  warehouseBrand?: string;
  warehousePaletteName?: string;
  updatedAt?: string;
  patterns?: ProjectPattern[];
  summary?: ProjectSummary;
  items?: ProjectRequirementItem[];
  missingItems?: ProjectRequirementItem[];
}

interface ProjectPattern {
  id: string;
  name: string;
  path: string;
  status: 'draft' | 'in_progress' | 'completed';
  gridDimensions?: { N: number; M: number };
  totalBeadCount?: number;
  colorCount?: number;
}

interface ProjectSummary {
  totalNeeded: number;
  totalOwned: number;
  totalMissing: number;
  missingColorCount: number;
}

interface ProjectRequirementItem {
  hex: string;
  colorKey: string;
  needed: number;
  owned: number;
  missing: number;
  remainingAfterProject: number;
}

const ROOT_DIR = process.cwd();
const PROJECTS_DIR = path.join(ROOT_DIR, 'results', 'projects');

export default async function ProjectsPage() {
  const projects = await readProjects();

  return (
    <main className="min-h-screen bg-slate-50 text-slate-950">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-3 border-b border-slate-200 pb-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <Link href="/" className="text-sm font-medium text-slate-500 hover:text-slate-900">返回主页</Link>
            <h1 className="mt-1 text-2xl font-semibold tracking-normal">加载项目</h1>
          </div>
          <div className="flex flex-wrap gap-2">
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

        {projects.length === 0 ? (
          <EmptyState text="还没有项目。可以先用 calc:project 脚本从 .grid.json 创建项目。" />
        ) : (
          <section className="flex flex-col gap-4">
            {projects.map((project) => {
              const missingItems = (project.missingItems ?? project.items?.filter((item) => item.missing > 0) ?? [])
                .slice()
                .sort((a, b) => b.missing - a.missing || compareColorKeys(a.colorKey, b.colorKey));
              const summary = project.summary;

              return (
                <article key={project.id} className="rounded border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <h2 className="text-lg font-semibold">{project.name}</h2>
                      <p className="mt-1 text-sm text-slate-500">
                        {project.warehouseName} · {project.warehouseBrand || 'MARD'} {project.warehousePaletteName || ''} · {project.patterns?.length ?? 0} 张图纸
                      </p>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-center text-sm sm:grid-cols-4">
                      <Stat label="总需求" value={String(summary?.totalNeeded ?? 0)} />
                      <Stat label="缺豆" value={String(summary?.totalMissing ?? 0)} tone={(summary?.totalMissing ?? 0) > 0 ? 'warn' : 'ok'} />
                      <Stat label="缺色" value={String(summary?.missingColorCount ?? 0)} tone={(summary?.missingColorCount ?? 0) > 0 ? 'warn' : 'ok'} />
                      <Stat label="图纸" value={String(project.patterns?.length ?? 0)} />
                    </div>
                  </div>

                  <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_1.4fr]">
                    <section>
                      <h3 className="text-sm font-semibold">图纸</h3>
                      <div className="mt-2 overflow-auto rounded border border-slate-100">
                        <table className="w-full min-w-[460px] border-collapse text-sm">
                          <thead>
                            <tr className="border-b border-slate-200 bg-slate-50 text-left text-slate-500">
                              <th className="px-3 py-2">名称</th>
                              <th className="px-3 py-2">尺寸</th>
                              <th className="px-3 py-2">状态</th>
                              <th className="px-3 py-2 text-right">豆数</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(project.patterns ?? []).map((pattern) => (
                              <tr key={pattern.id} className="border-b border-slate-100 last:border-b-0">
                                <td className="px-3 py-2">
                                  <div className="font-medium">{pattern.name}</div>
                                  <div className="max-w-[220px] truncate text-xs text-slate-500">{pattern.path}</div>
                                </td>
                                <td className="px-3 py-2 text-slate-600">
                                  {pattern.gridDimensions ? `${pattern.gridDimensions.N}x${pattern.gridDimensions.M}` : '-'}
                                </td>
                                <td className="px-3 py-2">
                                  <span className="rounded border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-600">
                                    {statusLabel(pattern.status)}
                                  </span>
                                </td>
                                <td className="px-3 py-2 text-right">{pattern.totalBeadCount ?? 0}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </section>

                    <section>
                      <h3 className="text-sm font-semibold">Missing</h3>
                      <div className="mt-2 overflow-auto rounded border border-slate-100">
                        <table className="w-full min-w-[560px] border-collapse text-sm">
                          <thead>
                            <tr className="border-b border-slate-200 bg-slate-50 text-left text-slate-500">
                              <th className="px-3 py-2">色号</th>
                              <th className="px-3 py-2">颜色</th>
                              <th className="px-3 py-2 text-right">需要</th>
                              <th className="px-3 py-2 text-right">库存</th>
                              <th className="px-3 py-2 text-right">缺少</th>
                            </tr>
                          </thead>
                          <tbody>
                            {missingItems.length === 0 ? (
                              <tr>
                                <td className="px-3 py-4 text-center text-slate-500" colSpan={5}>没有缺豆</td>
                              </tr>
                            ) : (
                              missingItems.map((item) => (
                                <tr key={`${item.hex}-${item.colorKey}`} className="border-b border-slate-100 last:border-b-0">
                                  <td className="px-3 py-2 font-semibold">{item.colorKey}</td>
                                  <td className="px-3 py-2">
                                    <span className="inline-flex items-center gap-2">
                                      <span className="h-6 w-6 rounded border border-slate-300" style={{ backgroundColor: item.hex }} />
                                      <span className="text-xs text-slate-500">{item.hex}</span>
                                    </span>
                                  </td>
                                  <td className="px-3 py-2 text-right">{item.needed}</td>
                                  <td className="px-3 py-2 text-right">{item.owned}</td>
                                  <td className="px-3 py-2 text-right font-semibold text-red-600">{item.missing}</td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>
                    </section>
                  </div>
                </article>
              );
            })}
          </section>
        )}
      </div>
    </main>
  );
}

async function readProjects(): Promise<ProjectFile[]> {
  try {
    const entries = await readdir(PROJECTS_DIR, { withFileTypes: true });
    const projects = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const projectPath = path.join(PROJECTS_DIR, entry.name, 'project.json');
          try {
            const text = await readFile(projectPath, 'utf8');
            return JSON.parse(text.replace(/^\uFEFF/, '')) as ProjectFile;
          } catch {
            return null;
          }
        })
    );
    return projects.filter((project): project is ProjectFile => project !== null);
  } catch {
    return [];
  }
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

function EmptyState({ text }: { text: string }) {
  return (
    <div className="rounded border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
      {text}
    </div>
  );
}

function statusLabel(status: ProjectPattern['status']): string {
  switch (status) {
    case 'in_progress':
      return '进行中';
    case 'completed':
      return '已完成';
    default:
      return '草稿';
  }
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
