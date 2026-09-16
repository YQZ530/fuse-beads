import json
from pathlib import Path
out=Path('results/3656');data=json.load(open(out/'layout.json'))
rows=data['rows'];n=len(data['parts']);count=sum(p['count'] for p in data['parts'])
s=Path('scripts/render_3648.py').read_text(encoding='utf-8')
s=s.replace("Path('results/3648')","Path('results/3656')").replace('else 78',f'else {rows}').replace('==37',f'=={n}').replace('==2428',f'=={count}')
s=s.replace('星月夜','向日葵').replace('37 个零件',f'{n} 个零件').replace('2,428',f'{count:,}').replace('i*240','i*300').replace('starry-night','sunflowers')
s=s.replace("'parts':37",f"'parts':{n}").replace("'beads':2428",f"'beads':{count}").replace('37 parts, 2428 cells',f'{n} parts, {count} cells')
Path('scripts/render_3656.py').write_text(s,encoding='utf-8')
