import json
from pathlib import Path
d=json.load(open('results/3648/best_partial.json'))
pos={1:(22,5),2:(0,0),9:(0,16),4:(22,37),7:(0,45),6:(23,64),13:(22,56)}
for p in d['parts']:
 if p['id'] in pos:p['x'],p['y']=pos[p['id']]
Path('results/3648/seed.json').write_text(json.dumps(d))
s=Path('scripts/pack_major_3648.cjs').read_text().replace('results/3648/best_partial.json','results/3648/seed.json').replace('if(run%3&&bx)','if(bx)').replace('run%3===0?500','run%3===0?20')
Path('scripts/pack_seed_3648.cjs').write_text(s)
