"""Read-only inventory comparison; save a warehouse snapshot and shopping CSV."""
from pathlib import Path
import csv, re, json, hashlib

root = Path(__file__).resolve().parents[1]
demand_path = root / 'summary_tot0913.txt'
snapshot_path = root / 'warehouse_221_purchased_snapshot_0913.csv'
output_path = root / '2nd stage shopping.csv'
source_bytes = snapshot_path.read_bytes()
with snapshot_path.open(encoding='utf-8-sig', newline='') as f:
    snapshot = list(csv.DictReader(f))
owned = {r['colorKey']: int(r['ownedCount']) for r in snapshot}
assert len(owned) == len(snapshot)
assert all(r['warehouseId'] == 'warehouse-221' and int(r['ownedCount']) >= 0 for r in snapshot)

text = demand_path.read_text(encoding='utf-8-sig')
pairs = re.findall(r'^([A-Z]+[0-9]+)\s+(\d+)\s*$', text, re.MULTILINE)
required = {c: int(n) for c, n in pairs}
assert len(required) == len(pairs)
assert len(required) == int(re.search(r'色号总数：(\d+)', text)[1])
assert sum(required.values()) == int(re.search(r'豆子总数：([\d,]+)', text)[1].replace(',', ''))
def key(code):
    m = re.fullmatch(r'([A-Z]+)(\d+)', code)
    return m[1], int(m[2])
def packs(n):
    return (max(n, 0) + 999) // 1000

headers = ['色号', '已购库存_颗', '最终需求_颗', '扣除需求后余额_负数为缺货',
           '缺失数量_颗', '缺货必买X数_1X等于1000颗', '缺货必买_颗',
           '必买后余量_颗', '低于300建议追加X数',
           '全部采纳合计X数', '建议购买合计_颗', '建议购买后余量_颗',
           '购买分类', '说明']
rows = []
for code in sorted(set(owned) | set(required), key=key):
    have, need = owned.get(code, 0), required.get(code, 0)
    remaining = have - need
    missing = max(0, -remaining)
    mandatory_packs = packs(missing)
    after_mandatory = remaining + mandatory_packs * 1000
    extra_packs = packs(300 - after_mandatory)
    suggested_packs = mandatory_packs + extra_packs
    after_suggested = remaining + suggested_packs * 1000
    category = ('缺货必买+低库存补购' if extra_packs else '缺货必买') if missing else ('低库存建议补购' if extra_packs else '无需购买')
    notes = []
    if code not in owned:
        notes.append('221色仓库无此色号，已购库存按0计算')
    if extra_packs:
        notes.append('补齐缺口后余量少于300，建议额外补购1k')
    if not need:
        notes.append('本次需求未使用此色')
    rows.append([code, have, need, remaining, missing, mandatory_packs,
                 mandatory_packs*1000, after_mandatory, extra_packs,
                 suggested_packs, suggested_packs*1000, after_suggested,
                 category, '；'.join(notes)])
    assert after_mandatory >= 0 and after_suggested >= 300
    assert (mandatory_packs == 0 or remaining + (mandatory_packs-1)*1000 < 0)
    assert (suggested_packs == 0 or remaining + (suggested_packs-1)*1000 < 300)

totals = [sum(r[i] for r in rows) for i in range(1, 12)]
assert totals[0] == sum(owned.values()) and totals[1] == sum(required.values())
assert totals[2] == totals[0] - totals[1]
assert totals[10] == totals[0] + totals[9] - totals[1]
shopping_rows = [r for r in rows if r[9] > 0]
shopping_totals = [sum(r[i] for r in shopping_rows) for i in range(1, 12)]
assert shopping_totals[4] == totals[4] and shopping_totals[7] == totals[7]
with (root / 'src/data/mardPaletteSets.csv').open(encoding='utf-8-sig', newline='') as f:
    palette_rows = [r for r in csv.DictReader(f) if r['brand'] == 'MARD' and r['paletteName'] == '221']
assert len(palette_rows) == 1
bundle_codes = set(palette_rows[0]['colorCodes'].split())
assert len(bundle_codes) == 221
today_packs = {'B15': 2, 'B17': 2, 'C7': 2, 'H2': 4, 'C3': 1, 'C6': 1, 'D4': 1, 'F11': 1}
assert sum(today_packs.values()) == 14
bundle_rows = []
frequent_rows = []
for code in sorted(set(owned) | set(required) | bundle_codes, key=key):
    have = owned.get(code, 0) + (1000 if code in bundle_codes else 0)
    have += 5000 if code in ('H2', 'H7') else 0
    have += today_packs.get(code, 0)*1000
    need = required.get(code, 0)
    balance = have - need
    shortage = max(0, -balance)
    must = packs(shortage)
    after_must = balance + must*1000
    extra = packs(300-after_must)
    buy = must + extra
    assert after_must >= 0 and balance + buy*1000 >= 300
    after_third = balance + buy*1000
    if need >= 1000 and after_third < 1000:
        frequent_rows.append([code, need, after_third, f'{packs(1000-after_third)}X（可选备货）'])
    if not buy:
        continue
    category = ('缺货必买+低库存补购' if extra else '缺货必买') if must else '低库存建议补购'
    note = '快照库存加221色每色1000颗、H2/H7各5000颗及今日明确购入14袋；未叠加第二部分购物建议'
    bundle_rows.append([code, have, need, balance, shortage, must, must*1000,
                        after_must, extra, buy, buy*1000, balance+buy*1000, category, note])
bundle_totals = [sum(r[i] for r in bundle_rows) for i in range(1,12)]
compact_headers = ['色号', '剩余', '缺失数量_颗', '买的倍数']
def compact_row(row):
    buy = f'{row[9]}X'
    if row[8]:
        buy += f'（必买{row[5]}X＋建议{row[8]}X）' if row[5] else '（建议）'
    return [row[0], row[3], row[4], buy]
def compact_total(label, section_totals):
    return [label, section_totals[2], section_totals[3],
            f'{section_totals[8]}X（必买{section_totals[4]}X＋建议{section_totals[7]}X）']
with output_path.open('w', encoding='utf-8-sig', newline='') as f:
    writer = csv.writer(f)
    writer.writerow(headers)
    def format_row(row):
        return [f'{value}X' if i in (5,8,9) else value for i,value in enumerate(row)]
    writer.writerows(format_row(row) for row in rows)
    writer.writerow(format_row(['TOTAL', *totals, '合计', '依据已购快照及summary_tot0913.txt(124278颗)；建议追加不属于缺货必买；未实际扣库或加入新套装']))
    writer.writerow([''] * 4)
    writer.writerow(['第二部分：仅列需购买或低库存色号；剩余为扣除需求后的余额，负数表示缺货；1X=1000颗', '', '', ''])
    writer.writerow(compact_headers)
    writer.writerows(compact_row(row) for row in shopping_rows)
    writer.writerow(compact_total('第二部分合计', shopping_totals))
    writer.writerow([''] * 4)
    writer.writerow(['第三部分：原库存＋221色各1k＋H2/H7各5k＋今日14袋；仅计已确认购买，不叠加第二部分建议', '', '', ''])
    writer.writerow(compact_headers)
    writer.writerows(compact_row(row) for row in bundle_rows)
    writer.writerow(compact_total('第三部分合计', bundle_totals))
    writer.writerow(['']*4)
    writer.writerow(['第四部分：用量至少1k，完成第三部分全部补购后余量仍不足1k的可选备货；不重复计算第三部分建议', '', '', ''])
    writer.writerow(['色号', '本次用量_颗', '第三部分全部补购后剩余_颗', '额外备货倍数'])
    writer.writerows(frequent_rows)
with output_path.open(encoding='utf-8-sig', newline='') as f:
    saved = list(csv.reader(f))
assert len(saved) == len(rows)+len(shopping_rows)+len(bundle_rows)+len(frequent_rows)+13
assert all(len(r) == 14 for r in saved[:len(rows)+2])
assert all(len(r) == 4 for r in saved[len(rows)+2:])
assert all([int(v.rstrip('X')) for v in row[1:12]] == original[1:12] for row, original in zip(saved[1:1+len(rows)], rows))
saved_shopping = saved[len(rows)+5:len(rows)+5+len(shopping_rows)]
assert len(saved_shopping) == len(shopping_rows)
assert [r[0] for r in saved_shopping] == [r[0] for r in shopping_rows]
assert saved_shopping == [[str(v) for v in compact_row(r)] for r in shopping_rows]
saved_bundle = saved[len(rows)+len(shopping_rows)+9:len(rows)+len(shopping_rows)+9+len(bundle_rows)]
assert len(saved_bundle) == len(bundle_rows)
assert saved_bundle == [[str(v) for v in compact_row(r)] for r in bundle_rows]
assert saved[-len(frequent_rows):] == [[str(v) for v in r] for r in frequent_rows]
assert snapshot_path.read_bytes() == source_bytes
summary = {'inventory_colors': len(owned), 'inventory_beads': totals[0],
           'required_colors': len(required), 'required_beads': totals[1],
           'shortage_colors': sum(r[4] > 0 for r in rows), 'shortage_beads': totals[3],
           'mandatory_purchase_packs': totals[4], 'mandatory_purchase_beads': totals[5],
           'low_stock_extra_colors': sum(r[8] > 0 for r in rows), 'extra_packs': totals[7],
           'suggested_purchase_colors': sum(r[9] > 0 for r in rows),
           'suggested_purchase_packs': totals[8], 'suggested_purchase_beads': totals[9],
           'remaining_after_suggested_purchase': totals[10],
           'inventory_sha256': hashlib.sha256(source_bytes).hexdigest()}
print(json.dumps(summary, indent=2))
print('LOW STOCK:', [(r[0], r[3], r[7], r[9]) for r in rows if r[8]])
print('AFTER BUNDLE:', [(r[0], r[5], r[8]) for r in bundle_rows])
print('AFTER BUNDLE TOTALS:', len(bundle_rows), 'colors;', bundle_totals[4], 'required packs;', bundle_totals[7], 'extra packs;', bundle_totals[8], 'combined packs')
print('NEEDED:', [(r[0],r[4],r[5],r[8]) for r in bundle_rows])
print('FREQUENT:', [(r[0],r[1],r[2]) for r in frequent_rows])
