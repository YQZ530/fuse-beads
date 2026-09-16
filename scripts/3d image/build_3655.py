import json
from pathlib import Path
out=Path('results/3655');old=json.load(open(out/'layout.json'));data=json.load(open(out/'extracted.json'))
pos={p['id']:(p['x'],p['y']) for p in old['placements']}
data['placements']=[dict(p,x=pos[p['id']][0],y=pos[p['id']][1]) for p in data['parts']]
data['rows']=80;json.dump(data,open(out/'layout.json','w'),indent=2)
s=Path('scripts/render_3648.py').read_text(encoding='utf-8')
s=s.replace("Path('results/3648')","Path('results/3655')").replace('else 78','else 80').replace('==37','==33').replace('==2428','==2504')
s=s.replace('星月夜','神奈川冲浪里').replace('37 个零件','33 个零件').replace('2,428','2,504').replace('starry-night','great-wave')
s=s.replace("'parts':37","'parts':33").replace("'beads':2428","'beads':2504").replace('37 parts, 2428 cells','33 parts, 2504 cells')
Path('scripts/render_3655.py').write_text(s,encoding='utf-8')
