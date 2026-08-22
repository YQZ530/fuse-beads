const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const rootDir = path.resolve(__dirname, '..');
const defaultInventoryPath = path.join(rootDir, 'results', 'warehouse', 'inventory.json');
const args = process.argv.slice(2);

function readArg(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function hasFlag(name) {
  return args.includes(name);
}

function normalizePath(filePath) {
  if (!filePath) return '';
  return path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath);
}

function toProjectRelativePath(filePath) {
  return path.relative(rootDir, filePath).replace(/\\/g, '/');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function readExistingProject(outputPath) {
  if (!fs.existsSync(outputPath)) return null;
  return readJson(outputPath);
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
  return String(a).localeCompare(String(b), 'en', { numeric: true });
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
    return {
      copyPatterns: true,
      ...readJson(inputPath),
    };
  }

  const patternArg = readArg('--patterns') || readArg('--pattern');
  const patterns = patternArg
    ? patternArg.split(',').map((item) => item.trim()).filter(Boolean).map((filePath) => ({ path: filePath }))
    : [];

  return {
    projectName: readArg('--project-name') || readArg('--name') || 'project',
    projectStatus: readArg('--status'),
    warehouseId: readArg('--warehouse') || 'warehouse-1',
    inventoryPath: readArg('--inventory') || 'results/warehouse/inventory.json',
    outputPath: readArg('--out'),
    copyPatterns: !hasFlag('--no-copy-patterns'),
    patterns,
  };
}

function defaultProjectPath(projectName) {
  return path.join(rootDir, 'results', 'projects', sanitizeFileName(projectName), 'project.json');
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

function loadPatterns(input, projectDir) {
  if (!Array.isArray(input.patterns) || input.patterns.length === 0) {
    throw new Error('Input must include at least one pattern path');
  }

  const usedFileNames = new Set();
  return input.patterns.map((patternInput) => {
    const patternPath = normalizePath(typeof patternInput === 'string' ? patternInput : patternInput.path);
    if (!patternPath || !fs.existsSync(patternPath)) {
      throw new Error(`Pattern file not found: ${patternPath || '(empty)'}`);
    }

    const grid = readJson(patternPath);
    const name = patternInput.name || grid.name || path.basename(patternPath, '.grid.json');
    const fileName = makePatternFileName(patternInput.fileName || name, usedFileNames);
    const targetPath = input.copyPatterns === false
      ? patternPath
      : copyPatternIntoProject(patternPath, projectDir, fileName);
    const status = normalizeStatus(patternInput.status);
    const now = new Date().toISOString();

    return {
      id: patternInput.id || grid.id || crypto.randomUUID(),
      name,
      fileName: path.basename(targetPath),
      path: toProjectRelativePath(targetPath),
      status,
      addedToPlanAt: patternInput.addedToPlanAt || now,
      completedAt: patternInput.completedAt,
      inventoryDeductedAt: patternInput.inventoryDeductedAt,
      grid,
    };
  });
}

function copyPatternIntoProject(sourcePath, projectDir, fileName) {
  const patternsDir = path.join(projectDir, 'patterns');
  const targetPath = path.join(patternsDir, fileName);
  if (path.resolve(sourcePath) === path.resolve(targetPath)) {
    return targetPath;
  }

  fs.mkdirSync(patternsDir, { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
  return targetPath;
}

function makePatternFileName(input, usedFileNames) {
  const extension = path.extname(input).toLowerCase() === '.json' ? '' : '.grid.json';
  const base = sanitizeFileName(path.basename(input, path.extname(input)).replace(/\.grid$/i, ''));
  let fileName = `${base}${extension || '.grid.json'}`;
  let copyIndex = 2;
  while (usedFileNames.has(fileName)) {
    fileName = `${base}_c${copyIndex}.grid.json`;
    copyIndex += 1;
  }
  usedFileNames.add(fileName);
  return fileName;
}

function buildWarehouseStock(warehouse) {
  const stock = new Map();
  for (const item of warehouse.items || []) {
    const hex = String(item.hex || '').toUpperCase();
    if (!hex) continue;
    stock.set(hex, {
      hex,
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

function buildProject(input, warehouse, patterns, existingProject) {
  const now = new Date().toISOString();
  const demand = new Map();
  const projectId = input.projectId || existingProject?.id || crypto.randomUUID();
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
    totalOwned: items.reduce((sum, item) => sum + Math.min(item.needed, item.owned), 0),
    totalMissing: items.reduce((sum, item) => sum + item.missing, 0),
    colorsNeeded: items.length,
    missingColorCount: items.filter((item) => item.missing > 0).length,
  };

  return {
    schemaVersion: 1,
    id: projectId,
    name: input.projectName || input.name || existingProject?.name || 'project',
    warehouseId: warehouse.id,
    warehouseName: warehouse.name,
    warehouseBrand: warehouse.brand || 'MARD',
    warehousePaletteName: warehouse.paletteName || '',
    warehouseLockedAt: existingProject?.warehouseLockedAt || now,
    status: normalizeStatus(input.projectStatus || input.status || existingProject?.status || deriveProjectStatus(patterns)),
    createdAt: input.createdAt || existingProject?.createdAt || now,
    updatedAt: now,
    patterns: patterns.map((pattern) => ({
      id: pattern.id,
      name: pattern.name,
      fileName: pattern.fileName,
      path: pattern.path,
      status: pattern.status,
      addedToPlanAt: pattern.addedToPlanAt,
      completedAt: pattern.completedAt,
      inventoryDeductedAt: pattern.inventoryDeductedAt,
      gridDimensions: pattern.grid.gridDimensions,
      totalBeadCount: Number(pattern.grid.totalBeadCount || 0),
      colorCount: Object.keys(pattern.grid.colorCounts || {}).length,
    })),
    summary,
    items,
    missingItems: items.filter((item) => item.missing > 0),
  };
}

function deriveProjectStatus(patterns) {
  if (patterns.some((pattern) => pattern.status === 'in_progress')) return 'in_progress';
  if (patterns.length > 0 && patterns.every((pattern) => pattern.status === 'completed')) return 'completed';
  return 'draft';
}

function normalizeStatus(status) {
  return status === 'in_progress' || status === 'completed' ? status : 'draft';
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

  writeFileAtomic(csvPath, `${rows}\n`);
  return csvPath;
}

function writeJsonAtomic(filePath, data) {
  writeFileAtomic(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function writeFileAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tempPath, content, 'utf8');
  JSON.stringify(readJsonSafe(tempPath));
  fs.renameSync(tempPath, filePath);
}

function readJsonSafe(filePath) {
  if (!filePath.endsWith('.json') && !filePath.endsWith('.tmp')) return {};
  try {
    return readJson(filePath);
  } catch {
    return {};
  }
}

function main() {
  const input = loadInput();
  const outputPath = normalizePath(input.outputPath) || defaultProjectPath(input.projectName || input.name);
  const projectDir = path.dirname(outputPath);
  const existingProject = readExistingProject(outputPath);
  const warehouse = loadWarehouse(input);
  const patterns = loadPatterns(input, projectDir);
  const project = buildProject(input, warehouse, patterns, existingProject);

  writeJsonAtomic(outputPath, project);
  const csvPath = writeProjectCsv(project, outputPath);

  console.log(`Wrote ${toProjectRelativePath(outputPath)}`);
  console.log(`Wrote ${toProjectRelativePath(csvPath)}`);
  if (input.copyPatterns !== false) {
    console.log(`Copied ${patterns.length} pattern file(s) into ${toProjectRelativePath(path.join(projectDir, 'patterns'))}`);
  }
  console.log(`Needed ${project.summary.totalNeeded}, missing ${project.summary.totalMissing} across ${project.summary.missingColorCount} colors`);
}

main();
