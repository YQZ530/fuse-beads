import crypto from 'crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'fs/promises';
import path from 'path';

export type ProjectStatus = 'draft' | 'in_progress' | 'completed';

export interface ProjectRequirementItem {
  hex: string;
  colorKey: string;
  needed: number;
  owned: number;
  missing: number;
  remainingAfterProject: number;
}

export interface ProjectSummary {
  totalNeeded: number;
  totalOwned: number;
  totalMissing: number;
  colorsNeeded: number;
  missingColorCount: number;
}

export interface ProjectPattern {
  id: string;
  name: string;
  fileName?: string;
  path?: string;
  thumbnailPath?: string;
  gridDimensions?: { N: number; M: number };
  totalBeadCount: number;
  colorCount: number;
  status: ProjectStatus;
  addedToPlanAt?: string;
  completedAt?: string;
  inventoryDeductedAt?: string;
}

export interface ProjectPatternColor {
  hex: string;
  colorKey: string;
  count: number;
}

export interface ProjectPatternPreviewCell {
  color: string;
  colorKey: string;
}

export interface ProjectPatternDetail {
  patternId: string;
  sourcePath: string;
  colors: ProjectPatternColor[];
  previewRows: ProjectPatternPreviewCell[][];
}

export interface ProjectFile {
  schemaVersion: number;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  warehouseId: string;
  warehouseName: string;
  warehouseBrand?: string;
  warehousePaletteName?: string;
  warehouseLockedAt: string;
  status: ProjectStatus;
  patterns: ProjectPattern[];
  summary: ProjectSummary;
  items: ProjectRequirementItem[];
  missingItems: ProjectRequirementItem[];
}

export interface ProjectDetailFile extends ProjectFile {
  patternDetails: Record<string, ProjectPatternDetail>;
}

export interface ProjectListItem {
  id: string;
  name: string;
  updatedAt: string;
  warehouseId: string;
  warehouseName: string;
  warehouseBrand?: string;
  warehousePaletteName?: string;
  status: ProjectStatus;
  patternCount: number;
  totalBeadCount: number;
  totalNeeded: number;
  totalMissing: number;
  missingColorCount: number;
  thumbnailPath?: string;
}

export interface ProjectWarehouseOption {
  id: string;
  name: string;
  brand: string;
  paletteName: string;
}

interface InventoryFile {
  warehouses?: Array<{
    id?: string;
    name?: string;
    brand?: string;
    paletteName?: string;
  }>;
}

export interface CreateProjectInput {
  name: string;
  warehouseId: string;
}

export interface RenameProjectInput {
  projectId: string;
  name: string;
}

export interface UpdateProjectPatternStatusInput {
  projectId: string;
  patternIds: string[];
  status: ProjectStatus;
}

interface PatternGridFile {
  mappedPixelData?: Array<Array<{ color?: string; key?: string }>>;
  colorCounts?: Record<string, {
    count?: number;
    color?: string;
    colorKey?: string;
    key?: string;
  }>;
}

interface InventoryStockFile {
  warehouses?: Array<{
    id?: string;
    items?: Array<{
      hex?: string;
      colorKey?: string;
      ownedCount?: number;
    }>;
  }>;
}

const ROOT_DIR = process.cwd();
const PROJECTS_DIR = path.join(ROOT_DIR, 'results', 'projects');
const INVENTORY_PATH = path.join(ROOT_DIR, 'results', 'warehouse', 'inventory.json');

export async function readProjectList(): Promise<ProjectListItem[]> {
  const projectRefs = await readProjectRefs();
  return projectRefs
    .map(({ project }) => ({
      id: project.id,
      name: project.name,
      updatedAt: project.updatedAt,
      warehouseId: project.warehouseId,
      warehouseName: project.warehouseName,
      warehouseBrand: project.warehouseBrand,
      warehousePaletteName: project.warehousePaletteName,
      status: project.status,
      patternCount: project.patterns.length,
      totalBeadCount: project.patterns.reduce((sum, pattern) => sum + pattern.totalBeadCount, 0),
      totalNeeded: project.summary.totalNeeded,
      totalMissing: project.summary.totalMissing,
      missingColorCount: project.summary.missingColorCount,
      thumbnailPath: project.patterns.find((pattern) => pattern.thumbnailPath)?.thumbnailPath,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function readProjectById(idOrDirectoryName: string): Promise<ProjectFile | null> {
  const match = await readProjectRefById(idOrDirectoryName);
  return match?.project ?? null;
}

export async function readProjectDetailById(idOrDirectoryName: string): Promise<ProjectDetailFile | null> {
  const match = await readProjectRefById(idOrDirectoryName);
  if (!match) return null;
  return enrichProjectDetail(match.project, match.directoryName);
}

export async function readProjectWarehouseOptions(): Promise<ProjectWarehouseOption[]> {
  const inventory = await readJsonFile<InventoryFile>(INVENTORY_PATH, { warehouses: [] });
  return (inventory.warehouses ?? [])
    .filter((warehouse) => warehouse.id && warehouse.name)
    .map((warehouse) => ({
      id: String(warehouse.id),
      name: String(warehouse.name),
      brand: String(warehouse.brand || 'MARD'),
      paletteName: String(warehouse.paletteName || ''),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
}

export async function createProject(input: CreateProjectInput): Promise<ProjectFile> {
  const name = input.name.trim();
  if (!name) {
    throw new Error('项目名称不能为空');
  }

  const warehouses = await readProjectWarehouseOptions();
  const warehouse = warehouses.find((candidate) => candidate.id === input.warehouseId);
  if (!warehouse) {
    throw new Error('找不到要绑定的豆仓');
  }

  const now = new Date().toISOString();
  const project: ProjectFile = {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    name,
    createdAt: now,
    updatedAt: now,
    warehouseId: warehouse.id,
    warehouseName: warehouse.name,
    warehouseBrand: warehouse.brand,
    warehousePaletteName: warehouse.paletteName,
    warehouseLockedAt: now,
    status: 'draft',
    patterns: [],
    summary: emptySummary(),
    items: [],
    missingItems: [],
  };
  const directoryName = await nextProjectDirectoryName(name);
  const projectPath = path.join(PROJECTS_DIR, directoryName, 'project.json');
  await writeJsonAtomic(projectPath, project);
  return project;
}

export async function renameProject(input: RenameProjectInput): Promise<ProjectDetailFile> {
  const name = input.name.trim();
  if (!name) {
    throw new Error('项目名称不能为空');
  }

  const match = await readProjectRefById(input.projectId);
  if (!match) {
    throw new Error('找不到项目');
  }

  const project: ProjectFile = {
    ...match.project,
    name,
    updatedAt: new Date().toISOString(),
  };

  await writeJsonAtomic(match.projectPath, project);
  return enrichProjectDetail(project, match.directoryName);
}

export async function updateProjectPatternStatuses(input: UpdateProjectPatternStatusInput): Promise<ProjectDetailFile> {
  const targetStatus = normalizeStatus(input.status);
  const patternIds = new Set(input.patternIds.map((id) => String(id || '').trim()).filter(Boolean));
  if (patternIds.size === 0) {
    throw new Error('请选择要移动的图纸');
  }

  const match = await readProjectRefById(input.projectId);
  if (!match) {
    throw new Error('找不到项目');
  }

  const now = new Date().toISOString();
  let updatedCount = 0;
  const nextProject: ProjectFile = {
    ...match.project,
    patterns: match.project.patterns.map((pattern) => {
      if (!patternIds.has(pattern.id)) return pattern;
      if (pattern.inventoryDeductedAt && targetStatus !== 'completed') {
        throw new Error('已扣库存的图纸需要走撤销完成流程');
      }
      updatedCount += 1;
      return {
        ...pattern,
        status: targetStatus,
        completedAt: targetStatus === 'completed' ? (pattern.completedAt || now) : undefined,
      };
    }),
    updatedAt: now,
  };

  if (updatedCount === 0) {
    throw new Error('没有找到要移动的图纸');
  }

  const recalculated = await recalculateProject(nextProject, match.directoryName);
  await writeJsonAtomic(match.projectPath, recalculated);
  return enrichProjectDetail(recalculated, match.directoryName);
}

export function compareColorKeys(a: string, b: string): number {
  const parsedA = parseColorKey(a);
  const parsedB = parseColorKey(b);
  if (parsedA.prefix !== parsedB.prefix) return parsedA.prefix.localeCompare(parsedB.prefix, 'en');
  if (parsedA.number !== parsedB.number) return parsedA.number - parsedB.number;
  return a.localeCompare(b, 'en', { numeric: true });
}

export function statusLabel(status: ProjectStatus): string {
  switch (status) {
    case 'in_progress':
      return '进行中';
    case 'completed':
      return '已完成';
    default:
      return '草稿';
  }
}

async function readProjectRefs(): Promise<Array<{ directoryName: string; projectPath: string; project: ProjectFile }>> {
  try {
    const entries = await readdir(PROJECTS_DIR, { withFileTypes: true });
    const projects = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const projectPath = path.join(PROJECTS_DIR, entry.name, 'project.json');
          try {
            const project = await readJsonFile<ProjectFile | null>(projectPath, null);
            if (!project) return null;
            return {
              directoryName: entry.name,
              projectPath,
              project: normalizeProject(project, entry.name),
            };
          } catch {
            return null;
          }
        })
    );
    return projects.filter((project): project is NonNullable<typeof project> => project !== null);
  } catch {
    return [];
  }
}

async function readProjectRefById(idOrDirectoryName: string): Promise<{ directoryName: string; projectPath: string; project: ProjectFile } | null> {
  const normalizedId = decodeURIComponent(idOrDirectoryName);
  const projectRefs = await readProjectRefs();
  return projectRefs.find(({ directoryName, project }) => (
    project.id === normalizedId || directoryName === normalizedId
  )) ?? null;
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const text = await readFile(filePath, 'utf8');
    return JSON.parse(text.replace(/^\uFEFF/, '')) as T;
  } catch {
    return fallback;
  }
}

async function enrichProjectDetail(project: ProjectFile, directoryName: string): Promise<ProjectDetailFile> {
  const details = await Promise.all(
    project.patterns.map(async (pattern) => buildPatternDetail(directoryName, pattern))
  );
  return {
    ...project,
    patternDetails: Object.fromEntries(details.map((detail) => [detail.patternId, detail])),
  };
}

async function buildPatternDetail(directoryName: string, pattern: ProjectPattern): Promise<ProjectPatternDetail> {
  const sourcePath = resolvePatternFilePath(directoryName, pattern);
  const grid = sourcePath ? await readJsonFile<PatternGridFile | null>(sourcePath, null) : null;
  return {
    patternId: pattern.id,
    sourcePath: sourcePath ? toProjectRelativePath(sourcePath) : '',
    colors: buildPatternColors(grid),
    previewRows: buildPreviewRows(grid),
  };
}

async function recalculateProject(project: ProjectFile, directoryName: string): Promise<ProjectFile> {
  const inventory = await readJsonFile<InventoryStockFile>(INVENTORY_PATH, { warehouses: [] });
  const warehouse = (inventory.warehouses ?? []).find((candidate) => candidate.id === project.warehouseId);
  const stock = new Map<string, { colorKey: string; ownedCount: number }>();
  for (const item of warehouse?.items ?? []) {
    const hex = String(item.hex || '').toUpperCase();
    if (!hex) continue;
    stock.set(hex, {
      colorKey: String(item.colorKey || ''),
      ownedCount: Number(item.ownedCount || 0),
    });
  }

  const demand = new Map<string, { hex: string; colorKey: string; needed: number }>();
  const activePatterns = project.patterns.filter((pattern) => (
    pattern.status === 'draft' || pattern.status === 'in_progress'
  ));

  for (const pattern of activePatterns) {
    const sourcePath = resolvePatternFilePath(directoryName, pattern);
    const grid = sourcePath ? await readJsonFile<PatternGridFile | null>(sourcePath, null) : null;
    for (const color of buildPatternColors(grid)) {
      const existing = demand.get(color.hex) || {
        hex: color.hex,
        colorKey: color.colorKey,
        needed: 0,
      };
      existing.needed += color.count;
      if (!existing.colorKey && color.colorKey) existing.colorKey = color.colorKey;
      demand.set(color.hex, existing);
    }
  }

  const items = Array.from(demand.values())
    .map((entry) => {
      const stockItem = stock.get(entry.hex);
      const owned = stockItem?.ownedCount ?? 0;
      return {
        hex: entry.hex,
        colorKey: entry.colorKey || stockItem?.colorKey || '',
        needed: entry.needed,
        owned,
        missing: Math.max(0, entry.needed - owned),
        remainingAfterProject: owned - entry.needed,
      };
    })
    .sort((a, b) => compareColorKeys(a.colorKey, b.colorKey));

  const summary = normalizeSummary(undefined, items);
  return {
    ...project,
    status: deriveProjectStatus(project.patterns),
    summary,
    items,
    missingItems: items.filter((item) => item.missing > 0),
  };
}

function buildPatternColors(grid: PatternGridFile | null): ProjectPatternColor[] {
  return Object.entries(grid?.colorCounts ?? {})
    .map(([hex, entry]) => ({
      hex: String(entry.color || hex).toUpperCase(),
      colorKey: String(entry.colorKey || entry.key || ''),
      count: Number(entry.count || 0),
    }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => compareColorKeys(a.colorKey, b.colorKey));
}

function buildPreviewRows(grid: PatternGridFile | null): ProjectPatternPreviewCell[][] {
  const rows = grid?.mappedPixelData ?? [];
  if (rows.length === 0) return [];

  const maxRows = 18;
  const maxCols = 18;
  const rowStep = Math.max(1, Math.ceil(rows.length / maxRows));
  const colCount = Math.max(...rows.map((row) => row.length), 0);
  const colStep = Math.max(1, Math.ceil(colCount / maxCols));
  const previewRows: ProjectPatternPreviewCell[][] = [];

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += rowStep) {
    const row = rows[rowIndex];
    const previewRow: ProjectPatternPreviewCell[] = [];
    for (let colIndex = 0; colIndex < row.length; colIndex += colStep) {
      const cell = row[colIndex];
      previewRow.push({
        color: cell?.color || '#FFFFFF',
        colorKey: cell?.key || '',
      });
    }
    previewRows.push(previewRow);
  }

  return previewRows;
}

function resolvePatternFilePath(directoryName: string, pattern: ProjectPattern): string {
  const projectDir = path.join(PROJECTS_DIR, directoryName);
  const candidate = pattern.path
    ? normalizeInputPath(pattern.path)
    : pattern.fileName
      ? path.join(projectDir, 'patterns', pattern.fileName)
      : '';
  if (!candidate) return '';

  const resolved = path.resolve(candidate);
  const root = path.resolve(ROOT_DIR);
  return resolved.toLowerCase().startsWith(root.toLowerCase()) ? resolved : '';
}

function normalizeInputPath(filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(ROOT_DIR, filePath);
}

function toProjectRelativePath(filePath: string): string {
  return path.relative(ROOT_DIR, filePath).replace(/\\/g, '/');
}

async function writeJsonAtomic(filePath: string, data: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(tempPath, filePath);
}

async function nextProjectDirectoryName(name: string): Promise<string> {
  const base = sanitizeFileName(name);
  let candidate = base;
  let index = 2;
  while (await directoryExists(path.join(PROJECTS_DIR, candidate))) {
    candidate = `${base}_${index}`;
    index += 1;
  }
  return candidate;
}

async function directoryExists(directoryPath: string): Promise<boolean> {
  try {
    const entries = await readdir(directoryPath);
    return Array.isArray(entries);
  } catch {
    return false;
  }
}

function deriveProjectStatus(patterns: ProjectPattern[]): ProjectStatus {
  if (patterns.some((pattern) => pattern.status === 'in_progress')) return 'in_progress';
  if (patterns.length > 0 && patterns.every((pattern) => pattern.status === 'completed')) return 'completed';
  return 'draft';
}

function normalizeProject(input: Partial<ProjectFile>, directoryName: string): ProjectFile {
  const now = new Date().toISOString();
  const patterns = Array.isArray(input.patterns) ? input.patterns.map(normalizePattern) : [];
  const items = Array.isArray(input.items) ? input.items.map(normalizeRequirementItem) : [];
  const missingItems = Array.isArray(input.missingItems)
    ? input.missingItems.map(normalizeRequirementItem)
    : items.filter((item) => item.missing > 0);
  const summary = normalizeSummary(input.summary, items);

  return {
    schemaVersion: Number(input.schemaVersion || 1),
    id: String(input.id || directoryName),
    name: String(input.name || directoryName),
    createdAt: String(input.createdAt || now),
    updatedAt: String(input.updatedAt || input.createdAt || now),
    warehouseId: String(input.warehouseId || ''),
    warehouseName: String(input.warehouseName || '未绑定豆仓'),
    warehouseBrand: input.warehouseBrand,
    warehousePaletteName: input.warehousePaletteName,
    warehouseLockedAt: String(input.warehouseLockedAt || input.createdAt || now),
    status: normalizeStatus(input.status),
    patterns,
    summary,
    items,
    missingItems,
  };
}

function normalizePattern(input: Partial<ProjectPattern>): ProjectPattern {
  return {
    id: String(input.id || crypto.randomUUID()),
    name: String(input.name || input.fileName || '未命名图纸'),
    fileName: input.fileName,
    path: input.path,
    thumbnailPath: input.thumbnailPath,
    gridDimensions: input.gridDimensions,
    totalBeadCount: Number(input.totalBeadCount || 0),
    colorCount: Number(input.colorCount || 0),
    status: normalizeStatus(input.status),
    addedToPlanAt: input.addedToPlanAt,
    completedAt: input.completedAt,
    inventoryDeductedAt: input.inventoryDeductedAt,
  };
}

function normalizeRequirementItem(input: Partial<ProjectRequirementItem>): ProjectRequirementItem {
  const needed = Number(input.needed || 0);
  const owned = Number(input.owned || 0);
  return {
    hex: String(input.hex || '#000000').toUpperCase(),
    colorKey: String(input.colorKey || ''),
    needed,
    owned,
    missing: Number.isFinite(Number(input.missing)) ? Number(input.missing) : Math.max(0, needed - owned),
    remainingAfterProject: Number.isFinite(Number(input.remainingAfterProject))
      ? Number(input.remainingAfterProject)
      : owned - needed,
  };
}

function normalizeSummary(input: Partial<ProjectSummary> | undefined, items: ProjectRequirementItem[]): ProjectSummary {
  if (items.length === 0 && input) {
    return {
      totalNeeded: Number(input.totalNeeded || 0),
      totalOwned: Number(input.totalOwned || 0),
      totalMissing: Number(input.totalMissing || 0),
      colorsNeeded: Number(input.colorsNeeded || 0),
      missingColorCount: Number(input.missingColorCount || 0),
    };
  }

  const computed = {
    totalNeeded: items.reduce((sum, item) => sum + item.needed, 0),
    totalOwned: items.reduce((sum, item) => sum + Math.min(item.needed, item.owned), 0),
    totalMissing: items.reduce((sum, item) => sum + item.missing, 0),
    colorsNeeded: items.length,
    missingColorCount: items.filter((item) => item.missing > 0).length,
  };
  return {
    totalNeeded: computed.totalNeeded,
    totalOwned: computed.totalOwned,
    totalMissing: computed.totalMissing,
    colorsNeeded: computed.colorsNeeded,
    missingColorCount: computed.missingColorCount,
  };
}

function emptySummary(): ProjectSummary {
  return {
    totalNeeded: 0,
    totalOwned: 0,
    totalMissing: 0,
    colorsNeeded: 0,
    missingColorCount: 0,
  };
}

function normalizeStatus(status: unknown): ProjectStatus {
  return status === 'in_progress' || status === 'completed' ? status : 'draft';
}

function sanitizeFileName(input: string): string {
  const cleaned = String(input || 'project')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 80);
  return cleaned || 'project';
}

function parseColorKey(colorKey: string): { prefix: string; number: number } {
  const match = /^([A-Za-z]+)\s*0*(\d+)/.exec(String(colorKey));
  return {
    prefix: match?.[1]?.toUpperCase() ?? String(colorKey).toUpperCase(),
    number: match ? Number(match[2]) : Number.MAX_SAFE_INTEGER,
  };
}
