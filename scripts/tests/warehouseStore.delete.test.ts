import assert from 'node:assert/strict';
import { before, beforeEach, test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { WarehouseInventory } from '../../src/lib/warehouseStore';
import { readInventoryFiles, writeInventoryFiles, encodeInventory, decodeInventory } from '../../src/lib/warehouseCsv';

let tempRoot = '';
let store: typeof import('../../src/lib/warehouseStore');
const repoRoot = process.cwd();

before(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'warehouse-store-delete-'));
  process.chdir(tempRoot);
  store = await import('../../src/lib/warehouseStore');
});

beforeEach(async () => {
  await rm(path.join(tempRoot, 'results'), { recursive: true, force: true });
  await mkdir(path.join(tempRoot, 'results', 'app', 'warehouse'), { recursive: true });
  await mkdir(path.join(tempRoot, 'results', 'app', 'projects'), { recursive: true });
});

test('deleteWarehouse removes the target warehouse and its transactions only', async () => {
  await writeInventory(baseInventory());

  const nextInventory = await store.deleteWarehouse({ warehouseId: 'warehouse-extra' });

  assert.deepEqual(nextInventory.warehouses.map((warehouse) => warehouse.id), ['warehouse-main']);
  assert.deepEqual(nextInventory.transactions?.map((transaction) => transaction.id), ['txn-main', 'txn-out']);

  const persisted = await readInventory();
  assert.deepEqual(persisted.warehouses.map((warehouse) => warehouse.id), ['warehouse-main']);
  assert.deepEqual(persisted.transactions?.map((transaction) => transaction.id), ['txn-main', 'txn-out']);
});

test('deleteWarehouse rejects warehouses that are bound to a project', async () => {
  await writeInventory(baseInventory());
  await mkdir(path.join(tempRoot, 'results', 'app', 'projects', 'bound-project'), { recursive: true });
  await writeFile(
    path.join(tempRoot, 'results', 'app', 'projects', 'bound-project', 'project.json'),
    `${JSON.stringify({ name: '绑定项目', warehouseId: 'warehouse-main' }, null, 2)}\n`,
    'utf8'
  );

  await assert.rejects(
    () => store.deleteWarehouse({ warehouseId: 'warehouse-main' }),
    /已被项目绑定/
  );

  const persisted = await readInventory();
  assert.deepEqual(persisted.warehouses.map((warehouse) => warehouse.id), ['warehouse-main', 'warehouse-extra']);
  assert.deepEqual(persisted.transactions?.map((transaction) => transaction.id), ['txn-main', 'txn-out', 'txn-extra']);
});

test('deleteWarehouseTransaction removes one transaction and rolls back positive stock delta', async () => {
  await writeInventory(baseInventory());

  const nextInventory = await store.deleteWarehouseTransaction({
    warehouseId: 'warehouse-main',
    transactionId: 'txn-main',
  });

  assert.deepEqual(nextInventory.transactions?.map((transaction) => transaction.id), ['txn-out', 'txn-extra']);
  assert.equal(nextInventory.warehouses[0].items[0].ownedCount, 9);

  const persisted = await readInventory();
  assert.deepEqual(persisted.transactions?.map((transaction) => transaction.id), ['txn-out', 'txn-extra']);
  assert.equal(persisted.warehouses[0].items[0].ownedCount, 9);
});

test('deleteWarehouseTransaction removes one transaction and rolls back negative stock delta', async () => {
  await writeInventory(baseInventory());

  const nextInventory = await store.deleteWarehouseTransaction({
    warehouseId: 'warehouse-main',
    transactionId: 'txn-out',
  });

  assert.deepEqual(nextInventory.transactions?.map((transaction) => transaction.id), ['txn-main', 'txn-extra']);
  assert.equal(nextInventory.warehouses[0].items[1].ownedCount, 10);

  const persisted = await readInventory();
  assert.deepEqual(persisted.transactions?.map((transaction) => transaction.id), ['txn-main', 'txn-extra']);
  assert.equal(persisted.warehouses[0].items[1].ownedCount, 10);
});

test('deleteWarehouseTransaction rejects records from another warehouse', async () => {
  await writeInventory(baseInventory());

  await assert.rejects(
    () => store.deleteWarehouseTransaction({
      warehouseId: 'warehouse-main',
      transactionId: 'txn-extra',
    }),
    /不属于当前豆仓/
  );

  const persisted = await readInventory();
  assert.deepEqual(persisted.transactions?.map((transaction) => transaction.id), ['txn-main', 'txn-out', 'txn-extra']);
});

async function writeInventory(inventory: WarehouseInventory) {
  writeInventoryFiles(path.join(tempRoot, 'results', 'app', 'warehouse'), inventory);
}

async function readInventory(): Promise<WarehouseInventory> {
  return readInventoryFiles(path.join(tempRoot, 'results', 'app', 'warehouse'));
}

test('CSV round trip preserves metadata, multiline notes, links and empty transactions', () => {
  const inventory = baseInventory();
  inventory.warehouses[0].name = 'Warehouse, "A"\nsecond line';
  inventory.warehouses[0].items[0].note = 'Purchased, checked\nconfirmed';
  inventory.warehouses[0].items[0].sourcePaletteName = '96';
  inventory.transactions![0].projectId = 'project-1';
  inventory.transactions![0].patternId = 'Image13';
  inventory.transactions![0].imagePath = 'results/example.png';
  inventory.transactions!.push({ id: 'empty', warehouseId: 'warehouse-main', type: 'create_warehouse', createdAt: '2026-09-11', note: 'Empty, "entry"\nline', items: [] });
  const encoded = encodeInventory(inventory);
  assert.deepEqual(decodeInventory(encoded.inventoryText, encoded.transactionsText), inventory);
});

test('CSV invalid quantities fail rather than returning an empty warehouse', async () => {
  const dir = path.join(tempRoot, 'results', 'app', 'warehouse');
  const encoded = encodeInventory(baseInventory());
  await writeFile(path.join(dir, 'inventory.csv'), encoded.inventoryText.replace(',10,', ',-10,'));
  await writeFile(path.join(dir, 'transactions.csv'), encoded.transactionsText);
  await assert.rejects(store.readInventory, /ownedCount/);
});

test('concurrent updates preserve changes to different colors', async () => {
  await writeInventory(baseInventory());
  await Promise.all([
    store.updateWarehouseItem({ warehouseId: 'warehouse-main', colorKey: 'T1', ownedCount: 30 }),
    store.updateWarehouseItem({ warehouseId: 'warehouse-main', colorKey: 'A3', ownedCount: 40 }),
  ]);
  const result = await store.readInventory();
  assert.deepEqual(result.warehouses[0].items.map(item => item.ownedCount), [30, 40]);
  assert.equal(result.transactions!.length, 5);
});

test('rename persists warehouse metadata across all CSV rows', async () => {
  await writeInventory(baseInventory());
  await store.renameWarehouse({ warehouseId: 'warehouse-main', name: 'Renamed, warehouse' });
  assert.equal((await store.readInventory()).warehouses[0].name, 'Renamed, warehouse');
});

async function copyPaletteFixtures() {
  await mkdir(path.join(tempRoot, 'src', 'data'), { recursive: true });
  await mkdir(path.join(tempRoot, 'src', 'app'), { recursive: true });
  for (const file of ['src/data/mardPaletteSets.csv', 'src/app/colorSystemMapping.json']) {
    await writeFile(path.join(tempRoot, file), await readFile(path.join(repoRoot, file)));
  }
}

test('create 221-color warehouse and replenish persist through CSV', async () => {
  await copyPaletteFixtures();
  const { warehouse } = await store.createWarehouse({ name: 'CSV 221', paletteName: '221', ownedCount: 1000 });
  assert.equal(warehouse.items.length, 221);
  await store.replenishWarehouse({ warehouseId: warehouse.id, entries: [{ colorKey: 'H2', count: 5000 }], note: 'Purchase, "verified"\nreceipt' });
  const persisted = await store.readInventory();
  assert.equal(persisted.warehouses[0].items.find(item => item.colorKey === 'H2')!.ownedCount, 6000);
  assert.equal(persisted.transactions![1].note, 'Purchase, "verified"\nreceipt');
});

test('a pending CSV pair is recovered before reading', async () => {
  const dir = path.join(tempRoot, 'results', 'app', 'warehouse');
  await writeInventory(baseInventory());
  const next = baseInventory();
  next.warehouses[0].name = 'Recovered';
  const encoded = encodeInventory(next);
  await mkdir(path.join(dir, '.csv-pending'));
  await writeFile(path.join(dir, 'inventory.csv'), encoded.inventoryText);
  await writeFile(path.join(dir, '.csv-pending', 'transactions.csv'), encoded.transactionsText);
  assert.equal((await store.readInventory()).warehouses[0].name, 'Recovered');
});

function baseInventory(): WarehouseInventory {
  return {
    schemaVersion: 1,
    warehouses: [
      {
        id: 'warehouse-main',
        name: '主豆仓',
        brand: 'MARD',
        paletteName: '96',
        createdAt: '2026-08-14T00:00:00.000Z',
        updatedAt: '2026-08-14T00:00:00.000Z',
        items: [
          { hex: '#FFFFFF', colorKey: 'T1', ownedCount: 10 },
          { hex: '#FEFF8B', colorKey: 'A3', ownedCount: 7 },
        ],
      },
      {
        id: 'warehouse-extra',
        name: '备用豆仓',
        brand: 'MARD',
        paletteName: '96',
        createdAt: '2026-08-14T00:00:00.000Z',
        updatedAt: '2026-08-14T00:00:00.000Z',
        items: [
          { hex: '#000000', colorKey: 'H7', ownedCount: 20 },
        ],
      },
    ],
    transactions: [
      {
        id: 'txn-main',
        warehouseId: 'warehouse-main',
        type: 'manual_adjustment',
        createdAt: '2026-08-14T00:01:00.000Z',
        note: '主豆仓记录',
        items: [
          { hex: '#FFFFFF', colorKey: 'T1', delta: 1, before: 9, after: 10 },
        ],
      },
      {
        id: 'txn-out',
        warehouseId: 'warehouse-main',
        type: 'manual_adjustment',
        createdAt: '2026-08-14T00:03:00.000Z',
        note: '主豆仓出库记录',
        items: [
          { hex: '#FEFF8B', colorKey: 'A3', delta: -3, before: 10, after: 7 },
        ],
      },
      {
        id: 'txn-extra',
        warehouseId: 'warehouse-extra',
        type: 'manual_replenishment',
        createdAt: '2026-08-14T00:02:00.000Z',
        note: '备用豆仓记录',
        items: [
          { hex: '#000000', colorKey: 'H7', delta: 5, before: 15, after: 20 },
        ],
      },
    ],
  };
}
