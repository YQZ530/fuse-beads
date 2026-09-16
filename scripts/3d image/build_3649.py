import json
from pathlib import Path
out=Path('results/3649');data=json.load(open(out/'extracted.json'))
# Whole original parts, unchanged orientation, with one or two empty rows/columns.
positions={1:(0,0),13:(32,0),12:(0,32),9:(20,32),11:(34,32),10:(20,47),6:(34,45),2:(34,52),3:(40,52),4:(46,52),5:(20,56),7:(25,56),8:(30,56)}
data['placements']=[dict(p,x=positions[p['id']][0],y=positions[p['id']][1]) for p in data['parts']]
json.dump(data,open(out/'layout.json','w'),indent=2)
s=Path('scripts/render_3648.py').read_text(encoding='utf-8')
s=s.replace("Path('results/3648')","Path('results/3649')").replace('else 78','else 60').replace('==37','==13').replace('==2428','==1919')
s=s.replace('星月夜','戴珍珠耳环的少女').replace('37 个零件','13 个零件').replace('2,428','1,919').replace('i*240','i*205').replace('starry-night','girl-with-pearl-earring')
s=s.replace("'parts':37","'parts':13").replace("'beads':2428","'beads':1919").replace('37 parts, 2428 cells','13 parts, 1919 cells')
Path('scripts/render_3649.py').write_text(s,encoding='utf-8')
