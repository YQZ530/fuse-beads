from PIL import Image,ImageDraw
import numpy as np,json
from pathlib import Path
from scipy.ndimage import label,find_objects
OUT=Path('results/3652');OUT.mkdir(exist_ok=True)
im=Image.open('C:/Users/z5308/Desktop/Img 2/IMG_3652.JPG').convert('RGB');a=np.array(im)
pitch=16
regions=[('cloud_left',140,1184,18,8),('sky',508,1182,32,30),('small',140,1360,18,11),('grass',108,1534,22,5),('back',526,1708,30,30),('gold_strip',32,1822,30,8),('base',32,1982,30,6),('stem_left',176,2254,5,11),('stem_right',272,2190,5,15),('front_left',66,2254,29,26),('front_right',544,2218,30,28)]
codes=['H18','C23','C2','D17','A20','G19','G13','B3','B5','B8','B15']
refs=[(516,1190),(308,1384),(148,1384),(228,1208),(200,2278),(200,2326),(148,1528),(948,1574),(600,2626),(164,1368),(148,1464)]
colors=np.array([np.median(a[y-3:y+4,x-4:x+5].reshape(-1,3),axis=0) for x,y in refs]);print(dict(zip(codes,colors.tolist())))
parts=[]
for name,x0,y0,w,h in regions:
 grid=np.full((h,w),-1,int)
 for r in range(h):
  for c in range(w):
   if name=='front_left' and r<12 and c<20:continue
   x=round(x0+(c+.5)*pitch);y=round(y0+(r+.5)*pitch)
   pix=a[y-4:y+5,x-4:x+5].reshape(-1,3).astype(float);med=np.median(pix,axis=0)
   if med.max()-med.min()<15 and 140<med.mean()<225:continue
   rays=255-colors;alpha=np.clip(((med-colors)*rays).sum(axis=1)/np.maximum((rays*rays).sum(axis=1),1),0,.35)
   grid[r,c]=(np.linalg.norm(colors+alpha[:,None]*rays-med,axis=1)+alpha*10).argmin()
 labs,n=label(grid>=0,structure=np.ones((3,3)))
 for i,s in enumerate(find_objects(labs),1):
  rr,cc=s;g=grid[s].copy();g[labs[s]!=i]=-1
  parts.append(dict(id=len(parts)+1,region=name,source=[x0+cc.start*pitch,y0+rr.start*pitch],grid=g.tolist(),w=g.shape[1],h=g.shape[0],count=int((g>=0).sum())))
 crop=im.crop((x0-3,y0-3,x0+w*pitch+3,y0+h*pitch+3));draw=ImageDraw.Draw(crop)
 for r,c in zip(*np.where(grid>=0)):
  x=3+c*pitch;y=3+r*pitch;draw.rectangle((x+4,y+4,x+11,y+11),fill=tuple(colors[grid[r,c]].astype(int)),outline='red')
 crop.save(OUT/f'verify_{name}.png')
json.dump(dict(codes=codes,colors=colors.tolist(),parts=parts),open(OUT/'extracted.json','w'),indent=2)
print([(p['id'],p['region'],p['w'],p['h'],p['count']) for p in parts]);print('total',sum(p['count'] for p in parts))
