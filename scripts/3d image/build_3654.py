import json
from pathlib import Path
out=Path('results/3654');old=json.load(open(out/'layout.json'));data=json.load(open(out/'extracted.json'))
pos={p['id']:(p['x'],p['y']) for p in old['placements']}
data['placements']=[dict(p,x=pos[p['id']][0],y=pos[p['id']][1]) for p in data['parts']]
data['rows']=59;json.dump(data,open(out/'layout.json','w'),indent=2)
s=Path('scripts/render_3648.py').read_text(encoding='utf-8')
s=s.replace("Path('results/3648')","Path('results/3654')").replace('else 78','else 59').replace('==37','==11').replace('==2428','==1914')
s=s.replace('星月夜','戴礼帽的苹果人物').replace('37 个零件','11 个零件').replace('2,428','1,914').replace('i*240','i*190').replace('starry-night','apple-bowler-figure')
s=s.replace("'parts':37","'parts':11").replace("'beads':2428","'beads':1914").replace('37 parts, 2428 cells','11 parts, 1914 cells')
Path('scripts/render_3654.py').write_text(s,encoding='utf-8')
