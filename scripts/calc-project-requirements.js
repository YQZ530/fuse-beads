const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const rootDir = path.resolve(__dirname, '..');
const defaultInventoryPath = path.join(rootDir, 'warehouse', 'inventory.json');
const args = process.argv.slice(2);

function readArg(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function normalizePath(filePath) {
  if (!filePath) return '';
  return path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function sanitizeFileName(input) {
  const cleaned = String(input || 'project')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 80);
  return cleaned || 'project';
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function compareColorKeys(a, b) {
  const parsedA = parseColorKey(a);
  const parsedB = parseColorKey(b);
  if (parsedA.prefix !== parsedB.prefix) {
    return parsedA.prefix.localeCompare(parsedB.prefix, 'en');
  }
  if (parsedA.number !== parsedB.number) {
    return parsedA.number - parsedB.number;
  }
  return a.localeCompare(b, 'en', { numeric: true });
}

function parseColorKey(colorKey) {
  const match = /^([A-Za-z]+)\s*0*(\d+)/.exec(String(colorKey));
  return {
    prefix: match?.[1]?.toUpperCase() ?? String(colorKey).toUpperCase(),
    number: match ? Number(match[2]) : Number.MAX_SAFE_INTEGER,
  };
}

function loadInput() {
  const inputPath = normalizePath(readArg('--input'));
  if (inputPath) {
    return readJson(inputPath);
  }

  const patternArg = readArg('--patterns') || readArg('--pattern');
  const patterns = patternArg
    ? patternArg.split(',').map((item) => item.trim()).filter(Boolean).map((filePath) => ({ path: filePath }))
    : [];

  return {
    projectName: readArg('--project-name') || readArg('--name') || 'project',
    warehouseId: readArg('--warehouse') || 'warehouse-1',
    inventoryPath: readArg('--inventory') || 'warehouse/inventory.json',
    outputPath: readArg('--out'),
    patterns,
  };
}

function loadWarehouse(input) {
  const inventoryPath = normalizePath(input.inventoryPath) || defaultInventoryPath;
  const inventory = readJson(inventoryPath);
  if (!Array.isArray(inventory.warehouses)) {
    throw new Error(`Invalid inventory file: ${inventoryPath}`);
  }
  const warehouse = inventory.warehouses.find((item) => item.id === input.warehouseId) || inventory.warehouses[0];
  if (!warehouse) {
    throw new Error(`Warehouse not found: ${input.warehouseId || '(first warehouse)'}`);
  }
  return warehouse;
}

function loadPatterns(input) {
  if (!Array.isArray(input.patterns) || input.patterns.length === 0) {
    throw new Error('Input must include at least one pattern path');
  }

  return input.patterns.map((patternInput) => {
    const patternPath = normalizePath(typeof patternInput === 'string' ? patternInput : patternInput.path);
    if (!patternPath || !fs.existsSync(patternPath)) {
      throw new Error(`Pattern file not found: ${patternPath || '(empty)'}`);
    }
    const grid = readJson(patternPath);
    return {
      id: patternInput.id || grid.id || crypto.randomUUID(),
      name: patternInput.name || grid.name || path.basename(patternPath, '.grid.json'),
      path: path.relative(rootDir, patternPath).replace(/\\/g, '/'),
      status: patternInput.status || 'draft',
      grid,
    };
  });
}

function buildWarehouseStock(warehouse) {
  const stock = new Map();
  for (const item of warehouse.items || []) {
    stock.set(String(item.hex).toUpperCase(), {
      hex: String(item.hex).toUpperCase(),
      colorKey: item.colorKey || '',
      ownedCount: Number(item.ownedCount || 0),
    });
  }
  return stock;
}

function addColorCount(target, hex, colorKey, count) {
  const key = String(hex).toUpperCase();
  const existing = target.get(key) || {
    hex: key,
    colorKey,
    needed: 0,
  };
  existing.needed += count;
  if (!existing.colorKey && colorKey) {
    existing.colorKey = colorKey;
  }
  target.set(key, existing);
}

function buildProject(input, warehouse, patterns) {
  const now = new Date().toISOString();
  const demand = new Map();
  const projectId = input.projectId || crypto.randomUUID();
  const stock = buildWarehouseStock(warehouse);
  const activePatterns = patterns.filter((pattern) => pattern.status === 'draft' || pattern.status === 'in_progress');

  for (const pattern of activePatterns) {
    for (const [hex, entry] of Object.entries(pattern.grid.colorCounts || {})) {
      addColorCount(demand, entry.color || hex, entry.colorKey || entry.key || '', Number(entry.count || 0));
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

  const summary = {
    totalNeeded: items.reduce((sum, item) => sum + item.needed, 0),
    totalOwned: items.reduce((sum, item) => sum + item.owned, 0),
    totalMissing: items.reduce((sum, item) => sum + item.missing, 0),
    missingColorCount: items.filter((item) => item.missing > 0).length,
  };

  return {
    schemaVersion: 1,
    id: projectId,
    name: input.projectName || input.name || 'project',
    warehouseId: warehouse.id,
    warehouseName: warehouse.name,
    warehouseBrand: warehouse.brand,
    warehousePaletteName: warehouse.paletteName,
    warehouseLockedAt: now,
    createdAt: input.createdAt || now,
    updatedAt: now,
    patterns: patterns.map((pattern) => ({
      id: pattern.id,
      name: pattern.name,
      path: pattern.path,
      status: pattern.status,
      gridDimensions: pattern.grid.gridDimensions,
      totalBeadCount: pattern.grid.totalBeadCount,
      colorCount: Object.keys(pattern.grid.colorCounts || {}).length,
    })),
    summary,
    items,
    missingItems: items.filter((item) => item.missing > 0),
  };
}

function defaultProjectPath(projectName) {
  return path.join(rootDir, 'results', 'projects', sanitizeFileName(projectName), 'project.json');
}

function writeProjectCsv(project, outputPath) {
  const csvPath = outputPath.replace(/\.json$/i, '.requirements.csv');
  const rows = [
    ['hex', 'brand', 'paletteName', 'color_key', 'needed', 'owned', 'missing', 'remaining_after_project'].join(','),
    ...project.items.map((item) => [
      item.hex,
      project.warehouseBrand || 'MARD',
      project.warehousePaletteName || '',
      item.colorKey,
      item.needed,
      item.owned,
      item.missing,
      item.remainingAfterProject,
    ].map(csvEscape).join(',')),
  ].join('\n');

  fs.writeFileSync(csvPath, `${rows}\n`, 'utf8');
  return csvPath;
}

function main() {
  const input = loadInput();
  const warehouse = loadWarehouse(input);
  const patterns = loadPatterns(input);
  const project = buildProject(input, warehouse, patterns);
  const outputPath = normalizePath(input.outputPath) || defaultProjectPath(project.name);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(project, null, 2)}\n`, 'utf8');
  const csvPath = writeProjectCsv(project, outputPath);

  console.log(`Wrote ${path.relative(rootDir, outputPath).replace(/\\/g, '/')}`);
  console.log(`Wrote ${path.relative(rootDir, csvPath).replace(/\\/g, '/')}`);
  console.log(`Needed ${project.summary.totalNeeded}, missing ${project.summary.totalMissing} across ${project.summary.missingColorCount} colors`);
}

main();
