from PIL import Image,ImageDraw
import numpy as np,json
from pathlib import Path
from scipy.ndimage import label,find_objects
OUT=Path('results/3654');OUT.mkdir(exist_ok=True)
im=Image.open('C:/Users/z5308/Desktop/Img 2/IMG_3654.JPG').convert('RGB');a=np.array(im)
pitch=18.7
regions=[('back',155,1134,30,30),('small_and_head',155,1751,24,27),('long_connector',660,1825,3,23),('body_left',43,2330,26,28),('body_right',548,2330,26,28)]
codes=['H7','H5','M15','H2','A1','G12','G10','F13','B26','F19','C3','C27','C23']
refs=[(519,1760),(613,2788),(239,2339),(239,2638),(221,2545),(221,2507),(333,2507),(277,2658),(221,2170),(202,2076),(183,1834),(164,1143),(258,1143)]
colors=np.array([np.median(a[y-2:y+3,x-3:x+4].reshape(-1,3),axis=0) for x,y in refs]);print(dict(zip(codes,colors.tolist())))
parts=[]
for name,x0,y0,w,h in regions:
 grid=np.full((h,w),-1,int)
 for r in range(h):
  for c in range(w):
   x=round(x0+(c+.5)*pitch);y=round(y0+(r+.5)*pitch)
   pix=a[y-5:y+6,x-5:x+6].reshape(-1,3).astype(float);med=np.median(pix,axis=0)
   if med.max()-med.min()<15 and 150<med.mean()<245:continue
   rays=255-colors;alpha=np.clip(((med-colors)*rays).sum(axis=1)/np.maximum((rays*rays).sum(axis=1),1),0,.35)
   grid[r,c]=(np.linalg.norm(colors+alpha[:,None]*rays-med,axis=1)+alpha*10).argmin()
   if med.max()-med.min()<10 and med.mean()<150:
    grid[r,c]=np.linalg.norm(colors[:3]-med,axis=1).argmin()
 labs,n=label(grid>=0,structure=np.ones((3,3)))
 for i,s in enumerate(find_objects(labs),1):
  rr,cc=s;g=grid[s].copy();g[labs[s]!=i]=-1
  parts.append(dict(id=len(parts)+1,region=name,source=[x0+cc.start*pitch,y0+rr.start*pitch],grid=g.tolist(),w=g.shape[1],h=g.shape[0],count=int((g>=0).sum())))
 crop=im.crop((x0-3,y0-3,x0+w*pitch+3,y0+h*pitch+3));draw=ImageDraw.Draw(crop)
 for r,c in zip(*np.where(grid>=0)):
  x=3+c*pitch;y=3+r*pitch;draw.rectangle((x+5,y+5,x+12,y+12),fill=tuple(colors[grid[r,c]].astype(int)),outline='red')
 crop.save(OUT/f'verify_{name}.png')
json.dump(dict(codes=codes,colors=colors.tolist(),parts=parts),open(OUT/'extracted.json','w'),indent=2)
print([(p['id'],p['region'],p['w'],p['h'],p['count']) for p in parts]);print('total',sum(p['count'] for p in parts))
