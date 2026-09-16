import json
from pathlib import Path
out=Path('results/3653');old=json.load(open(out/'layout.json'));data=json.load(open(out/'extracted.json'))
pos={p['id']:(p['x'],p['y']) for p in old['placements']}
data['placements']=[dict(p,x=pos[p['id']][0],y=pos[p['id']][1]) for p in data['parts']]
data['rows']=83;json.dump(data,open(out/'layout.json','w'),indent=2)
s=Path('scripts/render_3648.py').read_text(encoding='utf-8')
s=s.replace("Path('results/3648')","Path('results/3653')").replace('else 78','else 83').replace('==37','==14').replace('==2428','==2295')
s=s.replace('星月夜','呐喊').replace('37 个零件','14 个零件').replace('2,428','2,295').replace('i*240','i*205').replace('starry-night','the-scream')
s=s.replace("'parts':37","'parts':14").replace("'beads':2428","'beads':2295").replace('37 parts, 2428 cells','14 parts, 2295 cells')
Path('scripts/render_3653.py').write_text(s,encoding='utf-8')
