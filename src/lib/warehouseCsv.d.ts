import type { WarehouseInventory } from './warehouseStore';
export function decodeInventory(inventoryText: string, transactionsText: string): WarehouseInventory;
export function encodeInventory(inventory: WarehouseInventory): { inventoryText: string; transactionsText: string };
export function readInventoryFiles(dir: string): WarehouseInventory;
export function writeInventoryFiles(dir: string, inventory: WarehouseInventory): void;
export function withInventoryLock<T>(dir: string, work: () => T | Promise<T>): Promise<T>;
