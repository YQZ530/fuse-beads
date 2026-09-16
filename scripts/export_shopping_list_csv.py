import csv
from pathlib import Path

root = Path(__file__).resolve().parents[1]
source = root / '2nd stage shopping.csv'
output = root / '2nd stage shopping list.csv'
with source.open(encoding='utf-8-sig', newline='') as f:
    data = list(csv.DictReader(f))
rows = []
for item in data:
    if item['色号'] == 'TOTAL':
        continue
    required = int(item['缺货必买_1k包数'])
    extra = int(item['低于300建议追加_1k包数'])
    if required + extra == 0:
        continue
    shortage = int(item['缺失数量_颗'])
    rows.append([item['色号'], shortage, required+extra])
assert len(rows) == 77
assert sum(r[1] for r in rows) == 36756
assert sum(r[2] for r in rows) == 104
with output.open('w', encoding='utf-8-sig', newline='') as f:
    writer = csv.writer(f)
    writer.writerow(['色号', '缺少颗数', '需要买X数(含建议补购;1X=1000颗)'])
    writer.writerows(rows)
    writer.writerow(['TOTAL', 36756, 104])
with output.open(encoding='utf-8-sig', newline='') as f:
    saved = list(csv.reader(f))
assert len(saved) == 79
assert all(len(r) == 3 for r in saved)
assert sum(int(r[1]) for r in saved[1:-1]) == 36756
assert sum(int(r[2]) for r in saved[1:-1]) == 104
assert all(int(r[2])*1000 >= int(r[1]) for r in saved[1:-1])
print(output)
