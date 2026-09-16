from pathlib import Path
import re,json,sys
sys.stdout.reconfigure(encoding='utf-8')
from collections import defaultdict

out=Path('results/summary-heic')
observations=defaultdict(list)
page=None
for line in (out/'transcribed-pages.txt').read_text(encoding='utf-8').splitlines():
 if line.startswith('['):page=line.strip('[]');continue
 for code,count in re.findall(r'([A-Z]+[0-9]+)=([0-9]+)',line):
  observations[code].append({'page':page,'count':int(count)})
assert all(len({v['count'] for v in values})==1 for values in observations.values())
def sort_key(code):
 m=re.fullmatch(r'([A-Z]+)([0-9]+)',code)
 return m[1],int(m[2])
counts={k:observations[k][0]['count'] for k in sorted(observations,key=sort_key)}
assert len(counts)==211 and sum(counts.values())==103466
header='211 个色号，共 103,466 颗豆；与第一页总数一致。\n跨页重复项仅计一次，60 项重复数量全部一致。\n仅列出原图出现的色号；未出现的色号不补零。\n'
groups=defaultdict(list)
for code,n in counts.items():groups[sort_key(code)[0]].append((code,n))
lines=[header]
for group,items in groups.items():
 lines.append(f'[{group}]')
 for i in range(0,len(items),4):
  lines.append('  '.join(f'{c:<4} {n:>5}' for c,n in items[i:i+4]))
 lines.append('')
(out/'counts-A1-ZG.txt').write_text('\n'.join(lines),encoding='utf-8-sig')
md=[header,'| 色号 | 数量 | 色号 | 数量 | 色号 | 数量 |','|---|---:|---|---:|---|---:|']
items=list(counts.items())
for i in range(0,len(items),3):
 row=items[i:i+3]+[('', '')]*(3-len(items[i:i+3]))
 md.append('| '+' | '.join(str(v) for pair in row for v in pair)+' |')
(out/'counts-A1-ZG.md').write_text('\n'.join(md),encoding='utf-8')
(out/'counts-A1-ZG.json').write_text(json.dumps({'counts':counts,'observations':observations,'verification':{'unique_colors':211,'total_beads':103466,'header_matches':True,'duplicate_observations':60,'conflicts':[]},'method':'Visual transcription of circle labels and counts below; layout approach reviewed against stage2_analyze_helper_modal_legend.py; exact-code deduplication.'},ensure_ascii=False,indent=2),encoding='utf-8')
print('\n'.join(lines))
