from PIL import Image,ImageDraw
import numpy as np,json
from pathlib import Path
from scipy.ndimage import label,find_objects
OUT=Path('results/3651');OUT.mkdir(exist_ok=True)
im=Image.open('C:/Users/z5308/Desktop/Img 2/IMG_3651.JPG').convert('RGB');a=np.array(im)
pitch=19.55
regions=[('back',131,1095,30,30),('small',131,1779,37,14),('heads_accessories',111,2131,43,10),('body_left',52,2385,17,20),('body_middle',384,2366,17,21),('body_right',737,2366,15,21)]
codes=['H7','H2','A1','G11','G9','A4','F8','F7']
refs=[(140,1809),(238,1809),(160,2394),(395,1105),(140,1104),(160,1847),(316,1847),(220,1906)]
# Use clearly visible labelled swatches / bead interiors from this source only.
colors=np.array([np.median(a[y-5:y+6,x-5:x+6].reshape(-1,3),axis=0) for x,y in refs]);print(dict(zip(codes,colors.tolist())))
parts=[]
for name,x0,y0,w,h in regions:
 grid=np.full((h,w),-1,int)
 for r in range(h):
  for c in range(w):
   x=round(x0+(c+.5)*pitch);y=round(y0+(r+.5)*pitch)
   pix=a[y-6:y+7,x-6:x+7].reshape(-1,3).astype(float);med=np.median(pix,axis=0)
   if med.max()-med.min()<16 and 130<med.mean()<220:continue
   rays=255-colors;alpha=np.clip(((med-colors)*rays).sum(axis=1)/(rays*rays).sum(axis=1),0,.35)
   grid[r,c]=(np.linalg.norm(colors+alpha[:,None]*rays-med,axis=1)+alpha*10).argmin()
 labs,n=label(grid>=0,structure=np.ones((3,3)))
 for i,s in enumerate(find_objects(labs),1):
  rr,cc=s;g=grid[s].copy();g[labs[s]!=i]=-1
  parts.append(dict(id=len(parts)+1,region=name,source=[x0+cc.start*pitch,y0+rr.start*pitch],grid=g.tolist(),w=g.shape[1],h=g.shape[0],count=int((g>=0).sum())))
 crop=im.crop((x0-3,y0-3,x0+w*pitch+3,y0+h*pitch+3));draw=ImageDraw.Draw(crop)
 for r,c in zip(*np.where(grid>=0)):
  x=3+c*pitch;y=3+r*pitch;draw.rectangle((x+5,y+5,x+14,y+14),fill=tuple(colors[grid[r,c]].astype(int)),outline='blue')
 crop.save(OUT/f'verify_{name}.png')
json.dump(dict(codes=codes,colors=colors.tolist(),parts=parts),open(OUT/'extracted.json','w'),indent=2)
print([(p['id'],p['region'],p['w'],p['h'],p['count']) for p in parts]);print('total',sum(p['count'] for p in parts))
