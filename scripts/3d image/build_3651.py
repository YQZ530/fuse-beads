import json
from pathlib import Path
out=Path('results/3651');data=json.load(open(out/'extracted.json'))
positions={1:(0,0),22:(32,0),21:(0,32),20:(19,32),16:(32,23),14:(40,23),15:(38,35),17:(38,47),2:(48,0),3:(48,9),4:(48,17),5:(0,55),6:(5,55),7:(11,55),8:(15,55),9:(20,55),10:(23,55),11:(29,55),12:(36,57),13:(43,57),18:(29,59),19:(0,59)}
data['placements']=[dict(p,x=positions[p['id']][0],y=positions[p['id']][1]) for p in data['parts']]
json.dump(data,open(out/'layout.json','w'),indent=2)
s=Path('scripts/render_3648.py').read_text(encoding='utf-8')
s=s.replace("Path('results/3648')","Path('results/3651')").replace('else 78','else 64').replace('==37','==22').replace('==2428','==1843')
s=s.replace('星月夜','吹笛人物').replace('37 个零件','22 个零件').replace('2,428','1,843').replace('i*240','i*300').replace('starry-night','flute-player')
s=s.replace("'parts':37","'parts':22").replace("'beads':2428","'beads':1843").replace('37 parts, 2428 cells','22 parts, 1843 cells')
Path('scripts/render_3651.py').write_text(s,encoding='utf-8')
