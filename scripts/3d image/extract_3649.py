from PIL import Image,ImageDraw
import numpy as np,json
from pathlib import Path
from scipy.ndimage import label,find_objects
OUT=Path('results/3649');OUT.mkdir(exist_ok=True)
im=Image.open('C:/Users/z5308/Desktop/Img 2/IMG_3649.JPG').convert('RGB');a=np.array(im)
pitch=23.35
regions=[('back',110,1130,30,30),('small',110,1972,16,12),('face',578,1902,12,13),('shirt_small',204,2300,11,7),('shirt_large',578,2230,14,11),('portrait_left',87,2604,18,27),('portrait_right',602,2581,19,28)]
codes=['H7','H5','H2','G18','G12','G10','A8','B26','F19','C3','C7','D3']
refs=[(122,1984),(847,2312),(285,1984),(613,2054),(145,2077),(800,2943),(309,2031),(145,2147),(625,2171),(145,1984),(777,1937),(777,1914)]
colors=np.array([np.median(a[y-6:y+7,x-6:x+7].reshape(-1,3),axis=0) for x,y in refs])
print(dict(zip(codes,colors.tolist())))
parts=[]
for name,x0,y0,w,h in regions:
 grid=np.full((h,w),-1,int)
 for r in range(h):
  for c in range(w):
   x=round(x0+(c+.5)*pitch);y=round(y0+(r+.5)*pitch)
   pix=a[y-7:y+8,x-7:x+8].reshape(-1,3).astype(float);med=np.median(pix,axis=0)
   if med.max()-med.min()<16 and 125<med.mean()<205:continue
   # The source has a translucent white watermark. Compare each source
   # colour with its possible white-overlay values, without inventing colours.
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
  x=3+c*pitch;y=3+r*pitch
  draw.rectangle((x+6,y+6,x+17,y+17),fill=tuple(colors[grid[r,c]].astype(int)),outline='red')
 crop.save(OUT/f'verify_{name}.png')
json.dump(dict(codes=codes,colors=colors.tolist(),parts=parts),open(OUT/'extracted.json','w'),indent=2)
print([(p['id'],p['region'],p['w'],p['h'],p['count']) for p in parts]);print('total',sum(p['count'] for p in parts))
