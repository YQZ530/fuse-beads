from PIL import Image,ImageDraw
import numpy as np,json
from pathlib import Path
from scipy.ndimage import label,find_objects
OUT=Path('results/3653');OUT.mkdir(exist_ok=True)
im=Image.open('C:/Users/z5308/Desktop/Img 2/IMG_3653.JPG').convert('RGB');a=np.array(im)
pitch=15.65
regions=[('figure_back',70,1230,9,14),('figure_front',242,1183,18,17),('scene_front',556,1184,28,20),('small',86,1480,22,6),('base',540,1513,30,5),('scene_middle',54,1748,30,29),('scene_back',556,1748,30,30)]
codes=['H18','A2','A4','A6','F3','D1','C7','D22','D10','G11','G13','F11']
refs=[(752,1944),(422,2069),(924,1897),(218,2038),(564,1771),(1018,2022),(265,2006),(799,1411),(78,1316),(595,1991),(924,2069),(312,2100)]
colors=np.array([np.median(a[y-2:y+3,x-3:x+4].reshape(-1,3),axis=0) for x,y in refs]);print(dict(zip(codes,colors.tolist())))
parts=[]
for name,x0,y0,w,h in regions:
 grid=np.full((h,w),-1,int)
 for r in range(h):
  for c in range(w):
   x=round(x0+(c+.5)*pitch);y=round(y0+(r+.5)*pitch)
   pix=a[y-5:y+6,x-5:x+6].reshape(-1,3).astype(float);med=np.median(pix,axis=0)
   if med.max()-med.min()<15 and 130<med.mean()<225:continue
   rays=255-colors;alpha=np.clip(((med-colors)*rays).sum(axis=1)/np.maximum((rays*rays).sum(axis=1),1),0,.35)
   grid[r,c]=(np.linalg.norm(colors+alpha[:,None]*rays-med,axis=1)+alpha*10).argmin()
 # Printed source labels cover much of these tiny cells; use their explicit
 # source codes instead of the text-contaminated centre colour.
 label_cells={'figure_back':[(6,7,'D22')], 'scene_middle':[(3,25,'D22')], 'scene_back':[(20,12,'H18'),(20,13,'H18')]}
 for r,c,code in label_cells.get(name,[]):grid[r,c]=codes.index(code)
 labs,n=label(grid>=0,structure=np.ones((3,3)))
 for i,s in enumerate(find_objects(labs),1):
  rr,cc=s;g=grid[s].copy();g[labs[s]!=i]=-1
  parts.append(dict(id=len(parts)+1,region=name,source=[x0+cc.start*pitch,y0+rr.start*pitch],grid=g.tolist(),w=g.shape[1],h=g.shape[0],count=int((g>=0).sum())))
 crop=im.crop((x0-3,y0-3,x0+w*pitch+3,y0+h*pitch+3));draw=ImageDraw.Draw(crop)
 for r,c in zip(*np.where(grid>=0)):
  x=3+c*pitch;y=3+r*pitch;draw.rectangle((x+4,y+4,x+10,y+10),fill=tuple(colors[grid[r,c]].astype(int)),outline='cyan')
 crop.save(OUT/f'verify_{name}.png')
json.dump(dict(codes=codes,colors=colors.tolist(),parts=parts),open(OUT/'extracted.json','w'),indent=2)
print([(p['id'],p['region'],p['w'],p['h'],p['count']) for p in parts]);print('total',sum(p['count'] for p in parts))
