from pathlib import Path
import json,csv,sys
import numpy as np
from PIL import Image,ImageDraw,ImageFont
from scipy.ndimage import binary_dilation

out=Path('results/3656')
ROWS=int(sys.argv[1]) if len(sys.argv)>1 else 59
data=json.load(open(out/'layout.json')); codes=data['codes']; colors=[tuple(map(int,c)) for c in data['colors']]
grid=np.full((ROWS,52),-1,int); owners=np.zeros((ROWS,52),int)
assert len(data['placements'])==len(data['parts'])==19
for p in data['placements']:
 g=np.array(p['grid']); mask=g>=0; x,y=p['x'],p['y']; h,w=g.shape
 assert x>=0 and y>=0 and x+w<=52 and y+h<=ROWS
 assert not np.any(binary_dilation(owners>0,structure=np.ones((3,3)))[y:y+h,x:x+w]&mask),p['id']
 grid[y:y+h,x:x+w][mask]=g[mask]; owners[y:y+h,x:x+w][mask]=p['id']
 assert p['grid']==next(q['grid'] for q in data['parts'] if q['id']==p['id'])
assert (grid>=0).sum()==2040
S=48; L=72; T=180; W=L+52*S+48; H=T+ROWS*S+70
im=Image.new('RGB',(W,H),'white'); d=ImageDraw.Draw(im)
font=ImageFont.truetype('C:/Windows/Fonts/arial.ttf',17)
small=ImageFont.truetype('C:/Windows/Fonts/arial.ttf',17)
titlefont=ImageFont.truetype('C:/Windows/Fonts/msyh.ttc',34)
subfont=ImageFont.truetype('C:/Windows/Fonts/msyh.ttc',22)
svg=[f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">', '<rect width="100%" height="100%" fill="white"/>']
def text(x,y,s,size=17,color='#111111',anchor='middle'):
 svg.append(f'<text x="{x}" y="{y}" font-family="Arial,Microsoft YaHei,sans-serif" font-size="{size}" fill="{color}" text-anchor="{anchor}" dominant-baseline="central">{s}</text>')
d.text((L,25),'向日葵 · 全零件拼豆图纸',font=titlefont,fill='#111111')
text(L,46,'向日葵 · 全零件拼豆图纸',34,anchor='start')
desc=f'52 × {ROWS} 格  |  19 个零件  |  2,040 颗豆  |  色号依原图'
d.text((L,78),desc,font=subfont,fill='#444444');text(L,95,desc,22,anchor='start')
for i,(code,col) in enumerate(zip(codes,colors)):
 x=L+i*300; y=123
 d.rectangle((x,y,x+29,y+29),fill=col,outline='#555555');d.text((x+40,y+4),code,font=small,fill='black')
 svg.append(f'<rect x="{x}" y="{y}" width="29" height="29" fill="rgb{col}" stroke="#555555"/>');text(x+40,y+15,code,17,anchor='start')
# Stage 1: an exact 52-column by 78-row square lattice.
svg.append('<g id="grid" stroke="#929292" stroke-width="0.7">')
for c in range(53):
 x=L+c*S;d.line((x,T,x,T+ROWS*S),fill='#929292',width=1);svg.append(f'<path d="M{x} {T}V{T+ROWS*S}"/>')
for r in range(ROWS+1):
 y=T+r*S;d.line((L,y,L+52*S,y),fill='#929292',width=1);svg.append(f'<path d="M{L} {y}H{L+52*S}"/>')
svg.append('</g><g id="cell-colors">')
# Stage 2: source colours; unoccupied cells are left white.
for r,c in zip(*np.where(grid>=0)):
 col=colors[grid[r,c]];x=L+c*S;y=T+r*S
 d.rectangle((x+1,y+1,x+S-1,y+S-1),fill=col)
 svg.append(f'<rect x="{x+.5}" y="{y+.5}" width="47" height="47" fill="rgb{col}"/>')
svg.append('</g><g id="color-codes">')
# Stage 3: one source colour code in each occupied square.
for r,c in zip(*np.where(grid>=0)):
 code=codes[grid[r,c]];col=colors[grid[r,c]]
 ink='white' if sum(v*k for v,k in zip(col,(.2126,.7152,.0722)))<130 else 'black'
 x=L+(c+.5)*S;y=T+(r+.5)*S
 d.text((x,y),code,font=font,fill=ink,anchor='mm');text(x,y,code,17,ink)
svg.append('</g>')
for c in range(52):
 x=L+(c+.5)*S;d.text((x,T-15),str(c+1),font=small,fill='#555555',anchor='mm');text(x,T-15,str(c+1),17,'#555555')
for r in range(ROWS):
 y=T+(r+.5)*S;d.text((L-18,y),str(r+1),font=small,fill='#555555',anchor='mm');text(L-18,y,str(r+1),17,'#555555')
text(L,T+ROWS*S+35,'空白格不放豆；零件保持原方向与孔位，零件间至少空一格。',20,anchor='start')
d.text((L,T+ROWS*S+22),'空白格不放豆；零件保持原方向与孔位，零件间至少空一格。',font=subfont,fill='#444444')
svg.append('</svg>')
(out/f'sunflowers-52x{ROWS}.svg').write_text('\n'.join(svg),encoding='utf-8')
im.save(out/f'sunflowers-52x{ROWS}.png',dpi=(300,300))
im.resize((W//2,H//2)).save(out/'preview.png')
with open(out/f'sunflowers-52x{ROWS}.csv','w',newline='',encoding='utf-8-sig') as f:
 wr=csv.writer(f);wr.writerows([[codes[v] if v>=0 else '' for v in row] for row in grid])
json.dump({'columns':52,'rows':ROWS,'parts':19,'beads':2040,'counts':{code:int((grid==i).sum()) for i,code in enumerate(codes)},'checks':['all original grids unchanged','no rotation','no overlap','at least one empty cell between different parts']},open(out/'verification.json','w'),ensure_ascii=False,indent=2)
print(f'Verified 19 parts, 2040 cells, 52 x {ROWS}, no overlap, one-cell clearance.')
