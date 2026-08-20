import crypto from 'crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'fs/promises';
import path from 'path';

type ColorMapping = Record<string, { MARD?: string }>;

export interface WarehouseInventory {
  schemaVersion: number;
  warehouses: Warehouse[];
  transactions?: WarehouseTransaction[];
}

export interface Warehouse {
  id: string;
  name: string;
  brand: 'MARD';
  paletteName: string;
  createdAt: string;
  updatedAt: string;
  items: WarehouseItem[];
}

export interface WarehouseItem {
  hex: string;
  colorKey: string;
  ownedCount: number;
  sourcePaletteName?: string;
  isExtraColor?: boolean;
  updatedAt?: string;
}

export interface WarehouseTransaction {
  id: string;
  warehouseId: string;
  type: 'create_warehouse' | 'manual_adjustment' | 'manual_replenishment';
  createdAt: string;
  note: string;
  items: WarehouseTransactionItem[];
}

export interface WarehouseTransactionItem {
  hex: string;
  colorKey: string;
  delta: number;
  before: number;
  after: number;
}

export interface MardPaletteOption {
  brand: 'MARD';
  paletteName: string;
  colorCount: number;
}

export interface MardColor {
  colorKey: string;
  hex: string;
}

export interface CreateWarehouseInput {
  name: string;
  paletteName: string;
  ownedCount: number;
}

export interface UpdateWarehouseItemInput {
  warehouseId: string;
  colorKey: string;
  ownedCount: number;
  note?: string;
}

export interface RenameWarehouseInput {
  warehouseId: string;
  name: string;
}

export interface ReplenishWarehouseInput {
  warehouseId: string;
  entries: Array<{ colorKey: string; count: number }>;
  note?: string;
}

export interface DeleteWarehouseInput {
  warehouseId: string;
}

export interface DeleteWarehouseTransactionInput {
  warehouseId: string;
  transactionId: string;
}

const ROOT_DIR = process.cwd();
const INVENTORY_PATH = path.join(ROOT_DIR, 'warehouse', 'inventory.json');
const PROJECTS_DIR = path.join(ROOT_DIR, 'results', 'projects');
const PALETTE_SETS_PATH = path.join(ROOT_DIR, 'src', 'data', 'mardPaletteSets.csv');
const COLOR_MAPPING_PATH = path.join(ROOT_DIR, 'src', 'app', 'colorSystemMapping.json');
const FIRST_VERSION_PALETTES = new Set(['96', '144', '291']);

export async function readInventory(): Promise<WarehouseInventory> {
  try {
    const text = await readFile(INVENTORY_PATH, 'utf8');
    const parsed = JSON.parse(text.replace(/^\uFEFF/, '')) as Partial<WarehouseInventory>;
    return normalizeInventory(parsed);
  } catch {
    return { schemaVersion: 1, warehouses: [], transactions: [] };
  }
}

export async function readMardPaletteOptions(): Promise<MardPaletteOption[]> {
  const paletteSets = await readPaletteSetRows();
  return paletteSets
    .filter((row) => row.brand === 'MARD' && FIRST_VERSION_PALETTES.has(row.paletteName))
    .map((row) => ({
      brand: 'MARD' as const,
      paletteName: row.paletteName,
      colorCount: row.colorCodes.length,
    }))
    .sort((a, b) => Number(a.paletteName) - Number(b.paletteName));
}

export async function readMardColors(paletteName = '291'): Promise<MardColor[]> {
  const [paletteSets, keyToHex] = await Promise.all([readPaletteSetRows(), readMardKeyToHex()]);
  const palette = paletteSets.find((row) => row.brand === 'MARD' && row.paletteName === paletteName);
  if (!palette) {
    throw new Error(`找不到 MARD ${paletteName} 色板`);
  }

  return palette.colorCodes.map((colorKey) => {
    const hex = keyToHex.get(colorKey);
    if (!hex) {
      throw new Error(`MARD 色号 ${colorKey} 缺少 hex 映射`);
    }
    return { colorKey, hex };
  });
}

export async function createWarehouse(input: CreateWarehouseInput): Promise<{ inventory: WarehouseInventory; warehouse: Warehouse }> {
  const name = input.name.trim();
  const paletteName = String(input.paletteName || '').trim();
  const ownedCount = Number(input.ownedCount);

  if (!name) {
    throw new Error('豆仓名称不能为空');
  }
  if (!FIRST_VERSION_PALETTES.has(paletteName)) {
    throw new Error('第一版只支持 MARD 96 / 144 / 291');
  }
  if (!Number.isInteger(ownedCount) || ownedCount < 0) {
    throw new Error('初始库存必须是非负整数');
  }

  const inventory = await readInventory();
  const colors = await readMardColors(paletteName);
  const now = new Date().toISOString();
  const warehouse: Warehouse = {
    id: makeWarehouseId(inventory, name),
    name,
    brand: 'MARD',
    paletteName,
    createdAt: now,
    updatedAt: now,
    items: colors.map((color) => ({
      hex: color.hex,
      colorKey: color.colorKey,
      ownedCount,
      sourcePaletteName: paletteName,
    })),
  };

  inventory.warehouses.push(warehouse);
  inventory.transactions = [
    ...(inventory.transactions ?? []),
    {
      id: crypto.randomUUID(),
      warehouseId: warehouse.id,
      type: 'create_warehouse',
      createdAt: now,
      note: `创建豆仓：${name}`,
      items: [],
    },
  ];

  await writeInventory(inventory);
  return { inventory, warehouse };
}

export async function updateWarehouseItem(input: UpdateWarehouseItemInput): Promise<WarehouseInventory> {
  const ownedCount = Number(input.ownedCount);
  if (!Number.isInteger(ownedCount) || ownedCount < 0) {
    throw new Error('库存必须是非负整数');
  }

  const inventory = await readInventory();
  const warehouse = findWarehouse(inventory, input.warehouseId);
  const item = findWarehouseItem(warehouse, input.colorKey);
  const before = Number(item.ownedCount || 0);
  const now = new Date().toISOString();

  item.ownedCount = ownedCount;
  item.updatedAt = now;
  warehouse.updatedAt = now;

  if (before !== ownedCount) {
    inventory.transactions = [
      ...(inventory.transactions ?? []),
      {
        id: crypto.randomUUID(),
        warehouseId: warehouse.id,
        type: 'manual_adjustment',
        createdAt: now,
        note: input.note?.trim() || '修改库存',
        items: [{
          hex: item.hex,
          colorKey: item.colorKey,
          delta: ownedCount - before,
          before,
          after: ownedCount,
        }],
      },
    ];
  }

  await writeInventory(inventory);
  return inventory;
}

export async function renameWarehouse(input: RenameWarehouseInput): Promise<{ inventory: WarehouseInventory; warehouse: Warehouse }> {
  const name = String(input.name || '').trim();
  if (!name) {
    throw new Error('豆仓名称不能为空');
  }

  const inventory = await readInventory();
  const warehouse = findWarehouse(inventory, input.warehouseId);
  warehouse.name = name;
  warehouse.updatedAt = new Date().toISOString();

  await writeInventory(inventory);
  return { inventory, warehouse };
}

export async function replenishWarehouse(input: ReplenishWarehouseInput): Promise<WarehouseInventory> {
  const merged = mergeReplenishEntries(input.entries);
  if (merged.length === 0) {
    throw new Error('没有可导入的补货记录');
  }

  const [inventory, allMardColors] = await Promise.all([readInventory(), readMardColors('291')]);
  const colorMap = new Map(allMardColors.map((color) => [color.colorKey, color]));
  const warehouse = findWarehouse(inventory, input.warehouseId);
  const now = new Date().toISOString();
  const transactionItems: WarehouseTransactionItem[] = [];

  for (const entry of merged) {
    const color = colorMap.get(entry.colorKey);
    if (!color) {
      throw new Error(`MARD 291 中找不到色号：${entry.colorKey}`);
    }

    let item = warehouse.items.find((candidate) => normalizeColorKey(candidate.colorKey) === entry.colorKey);
    if (!item) {
      item = {
        hex: color.hex,
        colorKey: entry.colorKey,
        ownedCount: 0,
        sourcePaletteName: '291',
        isExtraColor: !isColorInBasePalette(warehouse, entry.colorKey),
      };
      warehouse.items.push(item);
    }

    const before = Number(item.ownedCount || 0);
    item.ownedCount = before + entry.count;
    item.updatedAt = now;
    transactionItems.push({
      hex: item.hex,
      colorKey: item.colorKey,
      delta: entry.count,
      before,
      after: item.ownedCount,
    });
  }

  warehouse.updatedAt = now;
  inventory.transactions = [
    ...(inventory.transactions ?? []),
    {
      id: crypto.randomUUID(),
      warehouseId: warehouse.id,
      type: 'manual_replenishment',
      createdAt: now,
      note: input.note?.trim() || '补货导入',
      items: transactionItems,
    },
  ];

  await writeInventory(inventory);
  return inventory;
}

export async function deleteWarehouse(input: DeleteWarehouseInput): Promise<WarehouseInventory> {
  const inventory = await readInventory();
  const warehouse = findWarehouse(inventory, input.warehouseId);
  const boundProjects = await readProjectsBoundToWarehouse(warehouse.id);
  if (boundProjects.length > 0) {
    throw new Error(`这个豆仓已被项目绑定，不能删除：${boundProjects.join('、')}`);
  }

  inventory.warehouses = inventory.warehouses.filter((candidate) => candidate.id !== warehouse.id);
  inventory.transactions = (inventory.transactions ?? []).filter((transaction) => transaction.warehouseId !== warehouse.id);
  await writeInventory(inventory);
  return inventory;
}

export async function deleteWarehouseTransaction(input: DeleteWarehouseTransactionInput): Promise<WarehouseInventory> {
  const inventory = await readInventory();
  const warehouse = findWarehouse(inventory, input.warehouseId);
  const transactions = inventory.transactions ?? [];
  const nextTransactions = transactions.filter((transaction) => transaction.id !== input.transactionId);
  if (nextTransactions.length === transactions.length) {
    throw new Error('找不到这条库存记录');
  }
  const deletedTransaction = transactions.find((transaction) => transaction.id === input.transactionId);
  if (deletedTransaction?.warehouseId !== warehouse.id) {
    throw new Error('这条库存记录不属于当前豆仓');
  }

  const now = new Date().toISOString();
  for (const transactionItem of deletedTransaction.items) {
    if (transactionItem.delta === 0) continue;
    const item = findWarehouseItem(warehouse, transactionItem.colorKey);
    const nextOwnedCount = Number(item.ownedCount || 0) - Number(transactionItem.delta || 0);
    if (!Number.isInteger(nextOwnedCount) || nextOwnedCount < 0) {
      throw new Error(`删除记录会导致 ${item.colorKey} 库存小于 0，已取消`);
    }
    item.ownedCount = nextOwnedCount;
    item.updatedAt = now;
  }

  warehouse.updatedAt = now;
  inventory.transactions = nextTransactions;
  await writeInventory(inventory);
  return inventory;
}

export function compareColorKeys(a: string, b: string): number {
  const parsedA = parseColorKey(a);
  const parsedB = parseColorKey(b);
  if (parsedA.prefix !== parsedB.prefix) return parsedA.prefix.localeCompare(parsedB.prefix, 'en');
  if (parsedA.number !== parsedB.number) return parsedA.number - parsedB.number;
  return a.localeCompare(b, 'en', { numeric: true });
}

export function normalizeColorKey(colorKey: string): string {
  return String(colorKey || '').trim().toUpperCase();
}

async function writeInventory(inventory: WarehouseInventory) {
  await mkdir(path.dirname(INVENTORY_PATH), { recursive: true });
  const tempPath = `${INVENTORY_PATH}.${crypto.randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(normalizeInventory(inventory), null, 2)}\n`, 'utf8');
  await rename(tempPath, INVENTORY_PATH);
}

function normalizeInventory(input: Partial<WarehouseInventory>): WarehouseInventory {
  return {
    schemaVersion: 1,
    warehouses: Array.isArray(input.warehouses) ? input.warehouses.map(normalizeWarehouse) : [],
    transactions: Array.isArray(input.transactions) ? input.transactions : [],
  };
}

function normalizeWarehouse(input: Partial<Warehouse>): Warehouse {
  const now = new Date().toISOString();
  return {
    id: String(input.id || crypto.randomUUID()),
    name: String(input.name || '未命名豆仓'),
    brand: 'MARD',
    paletteName: String(input.paletteName || '96'),
    createdAt: String(input.createdAt || now),
    updatedAt: String(input.updatedAt || input.createdAt || now),
    items: Array.isArray(input.items) ? input.items.map(normalizeWarehouseItem) : [],
  };
}

function normalizeWarehouseItem(input: Partial<WarehouseItem>): WarehouseItem {
  return {
    hex: String(input.hex || '#000000').toUpperCase(),
    colorKey: normalizeColorKey(String(input.colorKey || '')),
    ownedCount: Math.max(0, Number.isFinite(Number(input.ownedCount)) ? Number(input.ownedCount) : 0),
    sourcePaletteName: input.sourcePaletteName,
    isExtraColor: Boolean(input.isExtraColor),
    updatedAt: input.updatedAt,
  };
}

function findWarehouse(inventory: WarehouseInventory, warehouseId: string): Warehouse {
  const warehouse = inventory.warehouses.find((candidate) => candidate.id === warehouseId);
  if (!warehouse) {
    throw new Error('找不到豆仓');
  }
  return warehouse;
}

function findWarehouseItem(warehouse: Warehouse, colorKey: string): WarehouseItem {
  const normalizedKey = normalizeColorKey(colorKey);
  const item = warehouse.items.find((candidate) => normalizeColorKey(candidate.colorKey) === normalizedKey);
  if (!item) {
    throw new Error(`豆仓中找不到色号：${normalizedKey}`);
  }
  return item;
}

async function readProjectsBoundToWarehouse(warehouseId: string): Promise<string[]> {
  try {
    const entries = await readdir(PROJECTS_DIR, { withFileTypes: true });
    const boundProjects = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          try {
            const text = await readFile(path.join(PROJECTS_DIR, entry.name, 'project.json'), 'utf8');
            const project = JSON.parse(text.replace(/^\uFEFF/, '')) as { name?: string; warehouseId?: string };
            return project.warehouseId === warehouseId ? project.name || entry.name : null;
          } catch {
            return null;
          }
        })
    );
    return boundProjects.filter((projectName): projectName is string => projectName !== null);
  } catch {
    return [];
  }
}

function mergeReplenishEntries(entries: Array<{ colorKey: string; count: number }>): Array<{ colorKey: string; count: number }> {
  const merged = new Map<string, number>();

  for (const entry of entries) {
    const colorKey = normalizeColorKey(entry.colorKey);
    const count = Number(entry.count);
    if (!colorKey) continue;
    if (!Number.isInteger(count) || count <= 0) {
      throw new Error(`补货数量必须是正整数：${colorKey}`);
    }
    merged.set(colorKey, (merged.get(colorKey) || 0) + count);
  }

  return Array.from(merged.entries()).map(([colorKey, count]) => ({ colorKey, count }));
}

function isColorInBasePalette(warehouse: Warehouse, colorKey: string): boolean {
  return warehouse.items.some((item) => normalizeColorKey(item.colorKey) === normalizeColorKey(colorKey) && !item.isExtraColor);
}

function makeWarehouseId(inventory: WarehouseInventory, name: string): string {
  const base = sanitizeIdPart(name) || 'warehouse';
  let candidate = `warehouse-${base}`;
  let index = 2;
  while (inventory.warehouses.some((warehouse) => warehouse.id === candidate)) {
    candidate = `warehouse-${base}-${index}`;
    index += 1;
  }
  return candidate;
}

function sanitizeIdPart(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\u4e00-\u9fa5-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
}

function parseColorKey(colorKey: string): { prefix: string; number: number } {
  const match = /^([A-Za-z]+)\s*0*(\d+)/.exec(colorKey);
  return {
    prefix: match?.[1]?.toUpperCase() ?? colorKey.toUpperCase(),
    number: match ? Number(match[2]) : Number.MAX_SAFE_INTEGER,
  };
}

async function readPaletteSetRows(): Promise<Array<{ brand: string; paletteName: string; colorCodes: string[] }>> {
  const csv = await readFile(PALETTE_SETS_PATH, 'utf8');
  const lines = csv.trim().split(/\r?\n/);
  const header = parseCsvLine(lines[0]);
  const brandIndex = header.indexOf('brand');
  const paletteIndex = header.indexOf('paletteName');
  const codesIndex = header.indexOf('colorCodes');

  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    return {
      brand: cells[brandIndex],
      paletteName: cells[paletteIndex],
      colorCodes: cells[codesIndex].trim().split(/\s+/).filter(Boolean),
    };
  });
}

async function readMardKeyToHex(): Promise<Map<string, string>> {
  const mappingText = await readFile(COLOR_MAPPING_PATH, 'utf8');
  const mapping = JSON.parse(mappingText.replace(/^\uFEFF/, '')) as ColorMapping;
  const keyToHex = new Map<string, string>();

  for (const [hex, systems] of Object.entries(mapping)) {
    const colorKey = systems.MARD;
    if (!colorKey) continue;
    if (keyToHex.has(colorKey)) {
      throw new Error(`MARD 色号重复：${colorKey}`);
    }
    keyToHex.set(colorKey, hex.toUpperCase());
  }

  return keyToHex;
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      values.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  values.push(current);
  return values;
}
