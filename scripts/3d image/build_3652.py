import json
from pathlib import Path
out=Path('results/3652');old=json.load(open(out/'layout.json'));data=json.load(open(out/'extracted.json'))
pos={p['id']:(p['x'],p['y']) for p in old['placements']}
data['placements']=[dict(p,x=pos[p['id']][0],y=pos[p['id']][1]) for p in data['parts']]
data['rows']=90;json.dump(data,open(out/'layout.json','w'),indent=2)
s=Path('scripts/render_3648.py').read_text(encoding='utf-8')
s=s.replace("Path('results/3648')","Path('results/3652')").replace('else 78','else 90').replace('==37','==18').replace('==2428','==2906')
s=s.replace('星月夜','麦田与柏树').replace('37 个零件','18 个零件').replace('2,428','2,906').replace('i*240','i*220').replace('starry-night','wheatfield-cypresses')
s=s.replace("'parts':37","'parts':18").replace("'beads':2428","'beads':2906").replace('37 parts, 2428 cells','18 parts, 2906 cells')
Path('scripts/render_3652.py').write_text(s,encoding='utf-8')
