from PIL import Image,ImageDraw
import numpy as np,json
from pathlib import Path
from scipy.ndimage import label,find_objects
OUT=Path('results/3650');OUT.mkdir(exist_ok=True)
im=Image.open('C:/Users/z5308/Desktop/Img 2/IMG_3650.JPG').convert('RGB');a=np.array(im)
pitch=25.25
regions=[('back',166,1144,30,30),('base',166,1953,30,6),('mountain_1',170,2226,30,27),('mountain_2',170,2959,30,19),('mountain_3',170,3489,30,15),('mountain_4',190,3947,30,13),('small_left',190,4326,9,8),('small_right',468,4351,18,7)]
codes=['G10','G12','G7','C4','C5','D4','B10','B19','B12']
refcells=[(0,0),(1,13),(2,14),(11,3),(5,9),(10,3),(1,12),(1,10),(3,14)]
colors=[]
for c,r in refcells:
 x=round(166+(c+.5)*pitch);y=round(1144+(r+.5)*pitch)
 colors.append(np.median(a[y-8:y+9,x-8:x+9].reshape(-1,3),axis=0))
colors=np.array(colors);print(dict(zip(codes,colors.tolist())))
parts=[]
for name,x0,y0,w,h in regions:
 grid=np.full((h,w),-1,int)
 for r in range(h):
  for c in range(w):
   x=round(x0+(c+.5)*pitch);y=round(y0+(r+.5)*pitch)
   pix=a[y-8:y+9,x-8:x+9].reshape(-1,3).astype(float);med=np.median(pix,axis=0)
   if med.max()-med.min()<16 and 130<med.mean()<220:continue
   rays=255-colors
   alpha=np.clip(((med-colors)*rays).sum(axis=1)/(rays*rays).sum(axis=1),0,.35)
   distances=np.linalg.norm(colors+alpha[:,None]*rays-med,axis=1)+alpha*10
   grid[r,c]=distances.argmin()
 labs,n=label(grid>=0)
 for i,s in enumerate(find_objects(labs),1):
  rr,cc=s;g=grid[s].copy();g[labs[s]!=i]=-1
  parts.append(dict(id=len(parts)+1,region=name,source=[x0+cc.start*pitch,y0+rr.start*pitch],grid=g.tolist(),w=g.shape[1],h=g.shape[0],count=int((g>=0).sum())))
 crop=im.crop((x0-3,y0-3,x0+w*pitch+3,y0+h*pitch+3));draw=ImageDraw.Draw(crop)
 for r,c in zip(*np.where(grid>=0)):
  x=3+c*pitch;y=3+r*pitch;draw.rectangle((x+6,y+6,x+18,y+18),fill=tuple(colors[grid[r,c]].astype(int)),outline='red')
 crop.save(OUT/f'verify_{name}.png')
json.dump(dict(codes=codes,colors=colors.tolist(),parts=parts),open(OUT/'extracted.json','w'),indent=2)
print([(p['id'],p['region'],p['w'],p['h'],p['count']) for p in parts]);print('total',sum(p['count'] for p in parts))
