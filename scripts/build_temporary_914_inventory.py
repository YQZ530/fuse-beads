"""Build a fresh user-confirmed inventory; subtract both requirement sources."""
import csv,json,re,hashlib
from pathlib import Path
from collections import Counter

root=Path(__file__).resolve().parents[1]
warehouse_path=root/'results/app/warehouse/inventory.csv'
legend_path=root/'results/processing/2.groupped-bead-count/analyze_color_legend.main.json'
summary_path=root/'summary_tot0913.txt'
originals={p:hashlib.sha256(p.read_bytes()).hexdigest() for p in (warehouse_path,legend_path,summary_path)}
with warehouse_path.open(encoding='utf-8-sig',newline='') as f:
    warehouse_rows=[r for r in csv.DictReader(f) if r['warehouseId']=='warehouse-221' and r['colorKey']]
base={r['colorKey']:int(r['ownedCount']) for r in warehouse_rows}
assert len(base)==len(warehouse_rows) and base
assert all(r['paletteName']=='221' and int(r['ownedCount'])>=0 for r in warehouse_rows)
with (root/'src/data/mardPaletteSets.csv').open(encoding='utf-8-sig',newline='') as f:
    palettes=[r for r in csv.DictReader(f) if r['brand']=='MARD' and r['paletteName']=='221']
assert len(palettes)==1
codes=set(palettes[0]['colorCodes'].split())
assert len(codes)==221
extra_packs={'B15':2,'B17':2,'C7':3,'H2':4,'C3':1,'C6':1,'D4':1,'F11':1,'C16':2,'C24':1,'E2':3,'F4':1,'F10':1}
assert sum(extra_packs.values())==23 and set(extra_packs)<=codes
bonus={'H2':5000,'H7':5000}
owned={c:base.get(c,0)+(1000 if c in codes else 0)+bonus.get(c,0)+1000*extra_packs.get(c,0) for c in set(base)|codes}
assert sum(owned.values())==sum(base.values())+221000+10000+23000
additions_path=root/'temporary_914_additions.json'
additions=json.loads(additions_path.read_text(encoding='utf-8')) if additions_path.exists() else {}
assert all(c in owned and type(n) is int and n>=0 for c,n in additions.items())
for c,n in additions.items():
    owned[c]+=n
assert sum(owned.values())==sum(base.values())+221000+10000+23000+sum(additions.values())
def code_key(c):
    m=re.fullmatch(r'([A-Z]+)(\d+)',c)
    return m[1],int(m[2])
legend=json.loads(legend_path.read_text(encoding='utf-8-sig'))
images=legend['images']
assert len(images)==legend['imageCount']==len({p['id'] for p in images})
first=Counter()
for p in images:
    assert sum(p['colorCounts'].values())==p['totalBeads'],p['id']
    assert all(type(n) is int and n>=0 for n in p['colorCounts'].values())
    first.update(p['colorCounts'])
text=summary_path.read_text(encoding='utf-8-sig')
pairs=re.findall(r'^([A-Z]+\d+)\s+(\d+)\s*$',text,re.M)
second={c:int(n) for c,n in pairs}
assert len(second)==len(pairs)==int(re.search(r'色号总数：(\d+)',text)[1])
assert sum(second.values())==int(re.search(r'豆子总数：([\d,]+)',text)[1].replace(',',''))
inventory_rows=[[c,base.get(c,0),1000 if c in codes else 0,bonus.get(c,0),extra_packs.get(c,0)*1000,additions.get(c,0),owned[c]] for c in sorted(owned,key=code_key)]
inventory_out=root/'临时914库存.csv'
with inventory_out.open('w',encoding='utf-8-sig',newline='') as f:
    w=csv.writer(f);w.writerow(['色号','原221仓库存_颗_不含亚麻96仓','新购221套装_颗','新购H2_H7赠品_颗','新单买合计_颗','后续追加_颗','现有库存_颗'])
    w.writerows(inventory_rows)
    w.writerow(['TOTAL',sum(base.values()),221000,sum(bonus.values()),23000,sum(additions.values()),sum(owned.values())])
all_codes=set(owned)|set(first)|set(second)
rows=[]
for c in all_codes:
    stock=owned.get(c,0);a=first[c];b=second.get(c,0);remaining=stock-a-b
    rows.append([c,stock,a,b,a+b,remaining,max(0,-remaining)])
rows.sort(key=lambda r:(r[5],code_key(r[0])))
totals=[sum(r[i] for r in rows) for i in range(1,7)]
assert totals[0]==sum(owned.values())
assert totals[1]==sum(first.values()) and totals[2]==sum(second.values())
assert totals[4]==totals[0]-totals[3]
output=root/'临时914库存_扣除后剩余.csv'
with output.open('w',encoding='utf-8-sig',newline='') as f:
    w=csv.writer(f);w.writerow(['色号','现有库存_颗','legend需求_颗','summary_tot0913需求_颗','总需求_颗','剩余_颗_负数为缺货','缺失数量_颗'])
    w.writerows(rows);w.writerow(['TOTAL',*totals])
with output.open(encoding='utf-8-sig',newline='') as f:
    saved=list(csv.reader(f))
assert len(saved)==len(rows)+2
assert saved[1:-1]==[[str(v) for v in r] for r in rows]
assert all(rows[i][5]<=rows[i+1][5] for i in range(len(rows)-1))
assert all(hashlib.sha256(p.read_bytes()).hexdigest()==h for p,h in originals.items())
report={'stock':totals[0],'legend':totals[1],'summary':totals[2],'demand':totals[3],'net_remaining':totals[4],
        'shortage':totals[5],'shortage_colors':sum(r[5]<0 for r in rows),'positive_remaining':sum(max(0,r[5]) for r in rows),
        'base_warehouse':'warehouse-221','base_warehouse_beads':sum(base.values()),'excluded_warehouse':'warehouse-1',
        'new_bundle_beads':221000,'bonus_per_color':5000,'extra_packs':extra_packs,
        'subsequent_additions':additions,'subsequent_addition_beads':sum(additions.values()),
        'method':'Current warehouse-221 inventory plus new bundle, gifts, 23 single-color bags and recorded subsequent additions; deduct legend and current summary once each. No 96-color inventory or historical corrections added.'}
(root/'results/temporary-914-verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(report,ensure_ascii=True));print('LOWEST',rows[:12])
