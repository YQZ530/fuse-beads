# Warehouse CSV Storage

The authoritative files are `results/app/warehouse/inventory.csv` and `transactions.csv`. The web app and inventory scripts use these files. UTF-8 encoding and standard CSV quoting support commas, quotes and line breaks in names and notes.

## Inventory Columns

Each row represents one color in one warehouse. Warehouse metadata is repeated on every row of that warehouse and must agree. A warehouse with no colors has one row with an empty colorKey.

| Column | Meaning |
| --- | --- |
| schemaVersion | Format version, currently 1 |
| warehouseId | Stable ID referenced by projects and transactions |
| warehouseName | Display name |
| brand | MARD |
| paletteName | Base palette, such as 96 or 221 |
| warehouseCreatedAt | Original creation timestamp |
| warehouseUpdatedAt | Warehouse update timestamp |
| colorKey | MARD color code |
| hex | Color hex value |
| ownedCount | Current quantity, a nonnegative integer |
| sourcePaletteName | Source palette metadata |
| isExtraColor | true or false; empty means unspecified |
| itemUpdatedAt | Per-color update timestamp |
| note | Inventory or purchase note |

## Transaction Columns

A transaction can span multiple color rows, sharing the same transactionId. A transaction with no color changes retains one metadata row with an empty colorKey.

| Column | Meaning |
| --- | --- |
| schemaVersion | Format version, currently 1 |
| transactionId | Shared ID for all lines in an operation |
| warehouseId | Associated warehouse |
| type | create_warehouse, manual_adjustment or manual_replenishment |
| createdAt | Transaction timestamp |
| note | Description or purchase note |
| projectId | Optional project reference |
| patternId | Optional pattern reference, such as Image13 |
| imagePath | Optional repository-relative image path |
| colorKey | Affected MARD color |
| hex | Affected color hex value |
| delta | Signed quantity change: positive for inbound, negative for outbound |
| before | Quantity before this operation |
| after | Quantity after this operation; before + delta = after |

Images remain separate files. The reference columns store IDs or paths. These columns round-trip through storage; the current warehouse forms do not include a project/image attachment selector.

## Editing and Scripts

Use warehouseId to select inventory when multiple warehouses share a color. Existing project references keep `warehouse-1`; the purchased 221-color warehouse uses `warehouse-221`. Display names may contain Chinese; filenames, column names and generated IDs use ASCII.

```powershell
python scripts/python/helpers/calc_remaining_inventory.py --warehouse warehouse-1 --selected Image13 --only-used
python scripts/python/helpers/calc_remaining_inventory.py --warehouse warehouse-221 --selected Image13 --only-used
npm run create:warehouse -- --name "MARD 96" --palette 96 --count 541
```

The web app updates both files together using a write lock and a recoverable staging directory. Invalid quantities, duplicate colors, inconsistent metadata or broken transaction balances produce an error instead of silently replacing the inventory. Avoid external edits while the web app is saving. Directly editing a quantity does not automatically create a transaction; record its delta separately when history is required.

`seed:warehouse` initializes an empty store and refuses to overwrite existing stock. `create:warehouse` adds a warehouse and rejects duplicate IDs; `--out` must name an inventory.csv file with transactions.csv alongside it. `create_inventory_csv.py` generates an optional simple import snapshot, not the authoritative store.

## Migration

Current baseline after the user-confirmed reset: warehouse-1 contains only the standard MARD 96 colors at 541 each (51,936 beads); warehouse-221 retains 243,000 beads. Legacy extra colors A5, A8, B1, B4 and B6 have been removed from warehouse-1. All previous test/migration transactions have been cleared. transactions.csv currently contains only its header. The following paragraphs describe the earlier migration, before this reset.

The user-confirmed Linen 96 snapshot supplies the current quantities: 52,536 beads. Five extra colors from the previous web inventory retain their metadata at zero stock. The original warehouse ID, timestamps and transactions are preserved. A reconciliation transaction records the quantity differences.

MARD 221 opens with 243,000 beads, including all confirmed extra purchases. Its opening transaction records the per-color quantities. The former JSON and per-warehouse CSV files are superseded by this pair.

Original inputs are archived under `doc/archive/warehouse-before-csv/` using English filenames. They are historical snapshots and are not read or updated by the application.
