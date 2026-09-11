const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readInventoryFiles, writeInventoryFiles, withInventoryLock } = require('../../src/lib/warehouseCsv');

const rootDir = path.resolve(__dirname, '..', '..');
const paletteSetsPath = path.join(rootDir, 'src', 'data', 'mardPaletteSets.csv');
const colorMappingPath = path.join(rootDir, 'src', 'app', 'colorSystemMapping.json');
const warehouseDir = path.join(rootDir, 'results', 'app', 'warehouse');
const inventoryPath = path.join(warehouseDir, 'inventory.csv');

const args = process.argv.slice(2);
const options = {
  id: readArg('--id') || 'warehouse-1',
  name: readArg('--name') || '豆仓1',
  brand: readArg('--brand') || 'MARD',
  paletteName: readArg('--palette') || '96',
  ownedCount: Number(readArg('--count') || 541),
};

function readArg(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
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

function readPaletteCodes() {
  const csv = fs.readFileSync(paletteSetsPath, 'utf8').trim();
  const lines = csv.split(/\r?\n/);
  const header = parseCsvLine(lines[0]);
  const brandIndex = header.indexOf('brand');
  const paletteIndex = header.indexOf('paletteName');
  const codesIndex = header.indexOf('colorCodes');

  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    if (cells[brandIndex] === options.brand && cells[paletteIndex] === options.paletteName) {
      return cells[codesIndex].trim().split(/\s+/).filter(Boolean);
    }
  }

  throw new Error(`Palette not found: ${options.brand} ${options.paletteName}`);
}

function readMardKeyToHex() {
  const mapping = JSON.parse(fs.readFileSync(colorMappingPath, 'utf8'));
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

function main() {
  if (!Number.isInteger(options.ownedCount) || options.ownedCount < 0) {
    throw new Error(`Invalid --count value: ${options.ownedCount}`);
  }

  const colorCodes = readPaletteCodes();
  const keyToHex = readMardKeyToHex();
  const now = new Date().toISOString();

  const items = colorCodes.map((colorKey) => {
    const hex = keyToHex.get(colorKey);
    if (!hex) {
      throw new Error(`MARD color key missing from colorSystemMapping.json: ${colorKey}`);
    }
    return {
      hex,
      colorKey,
      ownedCount: options.ownedCount,
    };
  });

  const inventory = {
    schemaVersion: 1,
    warehouses: [
      {
        id: options.id,
        name: options.name,
        brand: options.brand,
        paletteName: options.paletteName,
        createdAt: now,
        updatedAt: now,
        items,
      },
    ],
  };

  if (readInventoryFiles(warehouseDir).warehouses.length) throw new Error('Inventory already exists; use create:warehouse to add a warehouse');
  inventory.transactions = [{ id: crypto.randomUUID(), warehouseId: options.id, type: 'create_warehouse', createdAt: now, note: 'Initial inventory',
    items: items.map(item => ({ hex: item.hex, colorKey: item.colorKey, delta: item.ownedCount, before: 0, after: item.ownedCount })) }];
  writeInventoryFiles(warehouseDir, inventory);

  console.log(`Wrote ${inventoryPath}`);
  console.log(`${options.name}: ${options.brand} ${options.paletteName}, ${items.length} colors, ${options.ownedCount} beads each`);
}

withInventoryLock(warehouseDir, main).catch(error => { console.error(error.message); process.exitCode = 1; });
