from PIL import Image,ImageDraw
import numpy as np,json
from pathlib import Path
from scipy.ndimage import label,find_objects
OUT=Path('results/3656');OUT.mkdir(exist_ok=True)
im=Image.open('C:/Users/z5308/Desktop/Img 2/IMG_3656.JPG').convert('RGB');a=np.array(im)
pitch=20.12
regions=[('top',144,1178,44,29),('main',64,1841,30,30),('small',728,2002,12,18),('back',224,2625,30,30)]
codes=['H12','A20','G19','G13','F7','B17','B11','B20']
refs=[(474,1630),(194,1348),(194,1328),(454,1288),(174,1408),(434,1328),(616,1430),(234,2635)]
colors=np.array([np.median(a[y-4:y+5,x-4:x+5].reshape(-1,3),axis=0) for x,y in refs]);print(dict(zip(codes,colors.tolist())))
parts=[]
for name,x0,y0,w,h in regions:
 grid=np.full((h,w),-1,int)
 for r in range(h):
  for c in range(w):
   x=round(x0+(c+.5)*pitch);y=round(y0+(r+.5)*pitch)
   med=np.median(a[y-6:y+7,x-6:x+7].reshape(-1,3),axis=0).astype(float)
   if med.max()-med.min()<16 and 125<med.mean()<242:continue
   rays=255-colors;alpha=np.clip(((med-colors)*rays).sum(axis=1)/np.maximum((rays*rays).sum(axis=1),1),0,.35)
   grid[r,c]=(np.linalg.norm(colors+alpha[:,None]*rays-med,axis=1)+alpha*10).argmin()
 labs,n=label(grid>=0,structure=np.ones((3,3)))
 for i,s in enumerate(find_objects(labs),1):
  rr,cc=s;g=grid[s].copy();g[labs[s]!=i]=-1
  parts.append(dict(id=len(parts)+1,region=name,source=[x0+cc.start*pitch,y0+rr.start*pitch],grid=g.tolist(),w=g.shape[1],h=g.shape[0],count=int((g>=0).sum())))
 crop=im.crop((x0-3,y0-3,x0+w*pitch+3,y0+h*pitch+3));draw=ImageDraw.Draw(crop)
 for r,c in zip(*np.where(grid>=0)):
  x=3+c*pitch;y=3+r*pitch;draw.rectangle((x+6,y+6,x+13,y+13),fill=tuple(colors[grid[r,c]].astype(int)),outline='cyan')
 crop.save(OUT/f'verify_{name}.png')
json.dump(dict(codes=codes,colors=colors.tolist(),parts=parts),open(OUT/'extracted.json','w'),indent=2)
print([(p['id'],p['region'],p['w'],p['h'],p['count']) for p in parts]);print('total',sum(p['count'] for p in parts))
