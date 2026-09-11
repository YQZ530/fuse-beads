const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readInventoryFiles, writeInventoryFiles, withInventoryLock } = require('../../src/lib/warehouseCsv');

const rootDir = path.resolve(__dirname, '..', '..');
const paletteSetsPath = path.join(rootDir, 'src', 'data', 'mardPaletteSets.csv');
const colorMappingPath = path.join(rootDir, 'src', 'app', 'colorSystemMapping.json');
const defaultInventoryPath = path.join(rootDir, 'results', 'app', 'warehouse', 'inventory.csv');
const args = process.argv.slice(2);

const options = {
  id: readArg('--id') || `warehouse-${crypto.randomUUID()}`,
  name: readArg('--name') || '豆仓1',
  brand: readArg('--brand') || 'MARD',
  paletteName: readArg('--palette') || '96',
  ownedCount: Number(readArg('--count') || 541),
  outputPath: normalizePath(readArg('--out')) || defaultInventoryPath,
  append: args.includes('--append'),
};

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

function parseCsvLine(line) {
  const values = [];
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

function readPaletteCodes(brand, paletteName) {
  const csv = fs.readFileSync(paletteSetsPath, 'utf8').trim();
  const lines = csv.split(/\r?\n/);
  const header = parseCsvLine(lines[0]);
  const brandIndex = header.indexOf('brand');
  const paletteIndex = header.indexOf('paletteName');
  const codesIndex = header.indexOf('colorCodes');

  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    if (cells[brandIndex] === brand && cells[paletteIndex] === paletteName) {
      return cells[codesIndex].trim().split(/\s+/).filter(Boolean);
    }
  }

  throw new Error(`Palette not found: ${brand} ${paletteName}`);
}

function readMardKeyToHex() {
  const mapping = readJson(colorMappingPath);
  const keyToHex = new Map();

  for (const [hex, systems] of Object.entries(mapping)) {
    const mardKey = systems.MARD;
    if (!mardKey) continue;
    if (keyToHex.has(mardKey)) {
      throw new Error(`Duplicate MARD color key: ${mardKey}`);
    }
    keyToHex.set(mardKey, hex.toUpperCase());
  }

  return keyToHex;
}

function readInventory(outputPath) {
  if (path.basename(outputPath) !== 'inventory.csv') throw new Error('--out must end with inventory.csv; transactions.csv is stored alongside it');
  return readInventoryFiles(path.dirname(outputPath));
}

function main() {
  if (!Number.isInteger(options.ownedCount) || options.ownedCount < 0) {
    throw new Error(`Invalid --count value: ${options.ownedCount}`);
  }
  if (options.brand !== 'MARD') {
    throw new Error('First version only supports --brand MARD');
  }

  const colorCodes = readPaletteCodes(options.brand, options.paletteName);
  const keyToHex = readMardKeyToHex();
  const now = new Date().toISOString();
  const items = colorCodes.map((colorKey) => {
    const hex = keyToHex.get(colorKey);
    if (!hex) {
      throw new Error(`MARD color key missing from colorSystemMapping.json: ${colorKey}`);
    }
    return { hex, colorKey, ownedCount: options.ownedCount };
  });

  const inventory = readInventory(options.outputPath);
  const warehouse = {
    id: options.id,
    name: options.name,
    brand: options.brand,
    paletteName: options.paletteName,
    createdAt: now,
    updatedAt: now,
    items,
  };

  const existingIndex = inventory.warehouses.findIndex((item) => item.id === options.id);
  if (existingIndex >= 0) {
    throw new Error(`Warehouse ID already exists: ${options.id}`);
  } else {
    inventory.warehouses.push(warehouse);
  }

  inventory.transactions = [...(inventory.transactions || []), {
    id: crypto.randomUUID(), warehouseId: warehouse.id, type: 'create_warehouse', createdAt: now,
    note: 'Initial inventory', items: items.map(item => ({ hex: item.hex, colorKey: item.colorKey, before: 0, after: item.ownedCount, delta: item.ownedCount })),
  }];
  writeInventoryFiles(path.dirname(options.outputPath), inventory);
  console.log(`Wrote ${path.relative(rootDir, options.outputPath).replace(/\\/g, '/')}`);
  console.log(`${warehouse.name}: ${warehouse.brand} ${warehouse.paletteName}, ${items.length} colors, ${options.ownedCount} beads each`);
}

withInventoryLock(path.dirname(options.outputPath), main).catch(error => { console.error(error.message); process.exitCode = 1; });
