const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert/strict');
const { parse } = require('csv-parse/sync');
const { readInventoryFiles, writeInventoryFiles, withInventoryLock } = require('../../src/lib/warehouseCsv');

const root = path.resolve(__dirname, '../..');
const args = process.argv.slice(2);
const arg = key => args[args.indexOf(key) + 1];
for (const key of ['--legacy', '--linen', '--mard221', '--out-dir']) {
  if (!args.includes(key) || !arg(key) || arg(key).startsWith('--')) throw new Error(`Required: ${key}`);
}
const outputDir = path.resolve(root, arg('--out-dir'));
const json = name => JSON.parse(fs.readFileSync(path.resolve(root, name), 'utf8').replace(/^\uFEFF/, ''));
const stock = name => parse(fs.readFileSync(path.resolve(root, name), 'utf8'), { columns: true, bom: true, skip_empty_lines: true });

withInventoryLock(outputDir, () => {
  if (fs.existsSync(path.join(outputDir, 'inventory.csv')) || fs.existsSync(path.join(outputDir, 'transactions.csv'))) throw new Error('CSV inventory already exists');
  const inventory = json(arg('--legacy'));
  const before = structuredClone(inventory);
  const linen = inventory.warehouses.find(w => w.id === 'warehouse-1');
  assert(linen, 'Expected existing warehouse-1');
  const mapping = json('src/app/colorSystemMapping.json');
  const colors = new Map(Object.entries(mapping).filter(([,row]) => row.MARD).map(([hex,row]) => [row.MARD,hex]));
  const now = new Date().toISOString();
  const confirmed = stock(arg('--linen'));
  assert.equal(confirmed.length,96);
  assert.equal(new Set(confirmed.map(row => row.colorKey)).size,96);
  const originalItems = new Map(linen.items.map(item => [item.colorKey,{...item}]));
  for (const item of linen.items) item.ownedCount = 0;
  for (const row of confirmed) {
    let item = linen.items.find(item => item.colorKey === row.colorKey);
    if (!item) { item = {colorKey:row.colorKey,hex:colors.get(row.colorKey)}; linen.items.push(item); }
    assert(colors.has(row.colorKey));
    const count = Number(row.ownedCount);
    assert(Number.isSafeInteger(count) && count >= 0);
    item.ownedCount = count;
    if (row.note) item.note = [item.note,row.note].filter(Boolean).join('; ');
  }
  const adjustments = linen.items.filter(item => (originalItems.get(item.colorKey)?.ownedCount || 0) !== item.ownedCount).map(item => {
    const previous = originalItems.get(item.colorKey)?.ownedCount || 0;
    return {hex:item.hex,colorKey:item.colorKey,before:previous,after:item.ownedCount,delta:item.ownedCount-previous};
  });
  inventory.transactions ||= [];
  if (adjustments.length) inventory.transactions.push({id:crypto.randomUUID(),warehouseId:linen.id,type:'manual_adjustment',createdAt:now,
    note:'Reconciled to user-confirmed Linen 96 CSV; legacy extra colors retained at zero stock',items:adjustments});
  const rows221 = stock(arg('--mard221'));
  assert.equal(rows221.length,221);
  assert.equal(new Set(rows221.map(row => row.colorKey)).size,221);
  assert(!inventory.warehouses.some(w=>w.id==='warehouse-221'));
  const warehouse221 = {id:'warehouse-221',name:'MARD 221',brand:'MARD',paletteName:'221',createdAt:now,updatedAt:now,
    items:rows221.map(row=>{
      assert(colors.has(row.colorKey));
      return {hex:colors.get(row.colorKey),colorKey:row.colorKey,ownedCount:Number(row.ownedCount),sourcePaletteName:'221',isExtraColor:false,note:row.note};
    })};
  inventory.warehouses.push(warehouse221);
  inventory.transactions.push({id:crypto.randomUUID(),warehouseId:warehouse221.id,type:'create_warehouse',createdAt:now,note:'Opening balance from user-confirmed MARD 221 purchases',
    items:warehouse221.items.map(item=>({hex:item.hex,colorKey:item.colorKey,before:0,after:item.ownedCount,delta:item.ownedCount}))});
  assert.equal(linen.items.reduce((n,item)=>n+item.ownedCount,0),52536);
  assert.equal(warehouse221.items.reduce((n,item)=>n+item.ownedCount,0),243000);
  for (const transaction of before.transactions || []) assert.deepEqual(inventory.transactions.find(t=>t.id===transaction.id),transaction);
  for (const warehouse of before.warehouses) {
    const current = inventory.warehouses.find(w=>w.id===warehouse.id);
    for (const [key,value] of Object.entries(warehouse)) if(key!=='items') assert.deepEqual(current[key],value);
    for (const item of warehouse.items) {
      const currentItem=current.items.find(i=>i.colorKey===item.colorKey);
      for (const [key,value] of Object.entries(item)) if(key!=='ownedCount' && key!=='note') assert.deepEqual(currentItem[key],value);
    }
  }
  writeInventoryFiles(outputDir,inventory);
  assert.deepEqual(readInventoryFiles(outputDir),inventory);
  console.log('Verified: 2 warehouses; Linen 96 = 52536; MARD 221 = 243000; legacy metadata and transactions preserved.');
}).catch(error=>{console.error(error);process.exitCode=1;});
