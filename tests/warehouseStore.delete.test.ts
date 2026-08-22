import assert from 'node:assert/strict';
import { before, beforeEach, test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { WarehouseInventory } from '../src/lib/warehouseStore';

let tempRoot = '';
let store: typeof import('../src/lib/warehouseStore');

before(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'warehouse-store-delete-'));
  process.chdir(tempRoot);
  store = await import('../src/lib/warehouseStore');
});

beforeEach(async () => {
  await rm(path.join(tempRoot, 'results'), { recursive: true, force: true });
  await mkdir(path.join(tempRoot, 'results', 'warehouse'), { recursive: true });
  await mkdir(path.join(tempRoot, 'results', 'projects'), { recursive: true });
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
  await mkdir(path.join(tempRoot, 'results', 'projects', 'bound-project'), { recursive: true });
  await writeFile(
    path.join(tempRoot, 'results', 'projects', 'bound-project', 'project.json'),
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
  await writeFile(
    path.join(tempRoot, 'results', 'warehouse', 'inventory.json'),
    `${JSON.stringify(inventory, null, 2)}\n`,
    'utf8'
  );
}

async function readInventory(): Promise<WarehouseInventory> {
  const text = await readFile(path.join(tempRoot, 'results', 'warehouse', 'inventory.json'), 'utf8');
  return JSON.parse(text) as WarehouseInventory;
}

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
