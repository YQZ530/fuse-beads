const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

const INVENTORY_COLUMNS = ['schemaVersion', 'warehouseId', 'warehouseName', 'brand', 'paletteName', 'warehouseCreatedAt', 'warehouseUpdatedAt', 'colorKey', 'hex', 'ownedCount', 'sourcePaletteName', 'isExtraColor', 'itemUpdatedAt', 'note'];
const TRANSACTION_COLUMNS = ['schemaVersion', 'transactionId', 'warehouseId', 'type', 'createdAt', 'note', 'projectId', 'patternId', 'imagePath', 'colorKey', 'hex', 'delta', 'before', 'after'];
const lockContext = new AsyncLocalStorage();

function rows(text, columns) {
  let hasHeader = false;
  const records = parse(text, { bom: true, skip_empty_lines: true, columns: header => {
    if (header.length !== columns.length || columns.some((key, i) => key !== header[i])) throw new Error('Invalid warehouse CSV headers');
    hasHeader = true;
    return header;
  }});
  if (!hasHeader) throw new Error('Missing warehouse CSV headers');
  return records;
}

function integer(value, name, signed = false) {
  if (!/^-?\d+$/.test(String(value))) throw new Error(`Invalid ${name}: ${value}`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || (!signed && number < 0)) throw new Error(`Invalid ${name}: ${value}`);
  return number;
}

function decodeInventory(inventoryText, transactionsText) {
  const warehouses = new Map();
  for (const row of rows(inventoryText, INVENTORY_COLUMNS)) {
    if (row.schemaVersion !== '1' || !row.warehouseId) throw new Error('Invalid warehouse metadata');
    const metadata = { id: row.warehouseId, name: row.warehouseName, brand: row.brand, paletteName: row.paletteName, createdAt: row.warehouseCreatedAt, updatedAt: row.warehouseUpdatedAt };
    let warehouse = warehouses.get(row.warehouseId);
    if (!warehouse) {
      warehouse = { ...metadata, items: [] };
      warehouses.set(row.warehouseId, warehouse);
    } else {
      for (const key of Object.keys(metadata)) if (warehouse[key] !== metadata[key]) throw new Error(`Inconsistent warehouse metadata: ${row.warehouseId}`);
    }
    if (!row.colorKey) continue;
    if (warehouse.items.some(item => item.colorKey === row.colorKey)) throw new Error(`Duplicate color: ${row.colorKey}`);
    if (row.isExtraColor && !['true', 'false'].includes(row.isExtraColor)) throw new Error('Invalid isExtraColor');
    warehouse.items.push({ colorKey: row.colorKey, hex: row.hex, ownedCount: integer(row.ownedCount, 'ownedCount'),
      ...(row.sourcePaletteName ? { sourcePaletteName: row.sourcePaletteName } : {}),
      ...(row.isExtraColor ? { isExtraColor: row.isExtraColor === 'true' } : {}),
      ...(row.itemUpdatedAt ? { updatedAt: row.itemUpdatedAt } : {}),
      ...(row.note ? { note: row.note } : {}),
    });
  }
  const transactions = new Map();
  for (const row of rows(transactionsText, TRANSACTION_COLUMNS)) {
    if (row.schemaVersion !== '1' || !row.transactionId || !warehouses.has(row.warehouseId)) throw new Error('Invalid transaction metadata');
    const metadata = { id: row.transactionId, warehouseId: row.warehouseId, type: row.type, createdAt: row.createdAt, note: row.note,
      ...(row.projectId ? { projectId: row.projectId } : {}), ...(row.patternId ? { patternId: row.patternId } : {}), ...(row.imagePath ? { imagePath: row.imagePath } : {}) };
    let transaction = transactions.get(row.transactionId);
    if (!transaction) {
      transaction = { ...metadata, items: [] };
      transactions.set(row.transactionId, transaction);
    } else {
      for (const key of ['id', 'warehouseId', 'type', 'createdAt', 'note', 'projectId', 'patternId', 'imagePath']) if (transaction[key] !== metadata[key]) throw new Error(`Inconsistent transaction: ${row.transactionId}`);
    }
    if (!row.colorKey) continue;
    if (transaction.items.some(item => item.colorKey === row.colorKey)) throw new Error('Duplicate transaction color');
    const item = { colorKey: row.colorKey, hex: row.hex, delta: integer(row.delta, 'delta', true), before: integer(row.before, 'before'), after: integer(row.after, 'after') };
    if (item.before + item.delta !== item.after) throw new Error('Transaction balance does not match');
    transaction.items.push(item);
  }
  return { schemaVersion: 1, warehouses: [...warehouses.values()], transactions: [...transactions.values()] };
}

function encodeInventory(inventory) {
  const stock = [];
  for (const warehouse of inventory.warehouses) {
    for (const item of warehouse.items.length ? warehouse.items : [{}]) stock.push({
      schemaVersion: 1, warehouseId: warehouse.id, warehouseName: warehouse.name, brand: warehouse.brand, paletteName: warehouse.paletteName,
      warehouseCreatedAt: warehouse.createdAt, warehouseUpdatedAt: warehouse.updatedAt,
      colorKey: item.colorKey, hex: item.hex, ownedCount: item.ownedCount, sourcePaletteName: item.sourcePaletteName,
      isExtraColor: item.isExtraColor === undefined ? '' : String(item.isExtraColor), itemUpdatedAt: item.updatedAt, note: item.note,
    });
  }
  const movements = [];
  for (const transaction of inventory.transactions || []) {
    for (const item of transaction.items.length ? transaction.items : [{}]) movements.push({
      schemaVersion: 1, transactionId: transaction.id, warehouseId: transaction.warehouseId, type: transaction.type,
      createdAt: transaction.createdAt, note: transaction.note, projectId: transaction.projectId, patternId: transaction.patternId, imagePath: transaction.imagePath,
      colorKey: item.colorKey, hex: item.hex, delta: item.delta, before: item.before, after: item.after,
    });
  }
  const inventoryText = stringify(stock, { header: true, columns: INVENTORY_COLUMNS });
  const transactionsText = stringify(movements, { header: true, columns: TRANSACTION_COLUMNS });
  decodeInventory(inventoryText, transactionsText);
  return { inventoryText, transactionsText };
}

// A staged pair is recoverable if the process exits between the two renames.
function recoverPending(dir) {
  const pending = path.join(dir, '.csv-pending');
  if (!fs.existsSync(pending)) return;
  for (const name of ['inventory.csv', 'transactions.csv']) {
    const staged = path.join(pending, name);
    if (fs.existsSync(staged)) fs.renameSync(staged, path.join(dir, name));
  }
  fs.rmdirSync(pending);
}

function readInventoryFiles(dir) {
  recoverPending(dir);
  const stock = path.join(dir, 'inventory.csv');
  const movements = path.join(dir, 'transactions.csv');
  if (!fs.existsSync(stock) && !fs.existsSync(movements)) return { schemaVersion: 1, warehouses: [], transactions: [] };
  return decodeInventory(fs.readFileSync(stock, 'utf8'), fs.readFileSync(movements, 'utf8'));
}

function writeInventoryFiles(dir, inventory) {
  const { inventoryText, transactionsText } = encodeInventory(inventory);
  fs.mkdirSync(dir, { recursive: true });
  recoverPending(dir);
  const stage = path.join(dir, `.csv-stage-${crypto.randomUUID()}`);
  fs.mkdirSync(stage);
  try {
    fs.writeFileSync(path.join(stage, 'inventory.csv'), inventoryText);
    fs.writeFileSync(path.join(stage, 'transactions.csv'), transactionsText);
    fs.renameSync(stage, path.join(dir, '.csv-pending'));
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
  recoverPending(dir);
}

async function withInventoryLock(dir, work) {
  dir = path.resolve(dir);
  if (lockContext.getStore() === dir) return work();
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, '.csv.lock');
  const deadline = Date.now() + 15000;
  let handle;
  while (handle === undefined) {
    try { handle = fs.openSync(lock, 'wx'); fs.writeSync(handle, String(process.pid)); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const owner = Number(fs.readFileSync(lock, 'utf8'));
        if (Number.isInteger(owner) && owner > 0) {
          try { process.kill(owner, 0); }
          catch (probe) {
            if (probe.code === 'ESRCH') { fs.unlinkSync(lock); continue; }
          }
        }
      } catch (probe) { if (probe.code === 'ENOENT') continue; throw probe; }
      if (Date.now() >= deadline) throw new Error('Warehouse CSV is busy; check for an interrupted writer');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  try { return await lockContext.run(dir, work); }
  finally { fs.closeSync(handle); fs.unlinkSync(lock); }
}

module.exports = { decodeInventory, encodeInventory, readInventoryFiles, writeInventoryFiles, withInventoryLock };
