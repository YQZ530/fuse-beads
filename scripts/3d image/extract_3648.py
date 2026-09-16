from PIL import Image
import numpy as np
from pathlib import Path
from scipy.ndimage import label, find_objects
import json

OUT=Path('results/3648'); OUT.mkdir(exist_ok=True)
im=Image.open('C:/Users/z5308/Desktop/Img 2/IMG_3648.JPG').convert('RGB')
a=np.array(im)
# Separate original drawing lattices, measured in the full resolution source.
regions=[('back',130,1121,30,30),('sky',130,2028,30,26),('frame',233,2845,29,14),('front',13,2955,29,24),('side',893,3285,4,15),('lower',68,3697,28,28),('base',80,4641,30,6),('small',60,4887,34,16)]
pitch=27.5
codes=['H2','H7','B15','A4','A16','D4','C9','C6','B10','C3']
# Reference bead interiors from the labelled source grid.
refs=[(8,0),(1,6),(29,25),(7,3),(1,0),(5,0),(4,0),(6,0),(22,4),(0,0)]
colors=[]
for c,r in refs:
 x=round(130+(c+.5)*pitch); y=round(1121+(r+.5)*pitch)
 colors.append(np.median(a[y-10:y+11,x-10:x+11].reshape(-1,3),axis=0))
colors=np.array(colors)
print(dict(zip(codes,colors.tolist())))
parts=[]
for name,x0,y0,w,h in regions:
 grid=np.full((h,w),-1,dtype=int)
 for r in range(h):
  for c in range(w):
   if name=='front' and r<10 and c>=8: continue # frame belongs to its separate lattice
   x=round(x0+(c+.5)*pitch); y=round(y0+(r+.5)*pitch)
   pix=a[y-9:y+10,x-9:x+10].reshape(-1,3).astype(float)
   med=np.median(pix,axis=0)
   if med.max()-med.min()<15 and 125<med.mean()<200: continue
   dist=np.linalg.norm(colors-med,axis=1)
   grid[r,c]=int(dist.argmin())
 labs,n=label(grid>=0)
 for i,s in enumerate(find_objects(labs),1):
  rr,cc=s
  g=grid[s].copy(); g[labs[s]!=i]=-1
  if (g>=0).sum()<2: print('singleton',name,rr,cc)
  parts.append({'id':len(parts)+1,'region':name,'source':[x0+cc.start*pitch,y0+rr.start*pitch], 'grid':g.tolist(),'w':g.shape[1],'h':g.shape[0],'count':int((g>=0).sum())})
 # Source overlay for extraction verification.
 crop=im.crop((max(0,x0-3),y0-3,x0+w*pitch+3,y0+h*pitch+3))
 from PIL import ImageDraw,ImageFont
 d=ImageDraw.Draw(crop)
 for r in range(h):
  for c in range(w):
   if grid[r,c]>=0:
    d.rectangle((3+c*pitch+7,3+r*pitch+7,3+c*pitch+20,3+r*pitch+20),fill=tuple(colors[grid[r,c]].astype(int)),outline='red',width=1)
 crop.save(OUT/f'verify_{name}.png')
json.dump({'codes':codes,'colors':colors.tolist(),'parts':parts},open(OUT/'extracted.json','w'),indent=2)
print([(p['id'],p['region'],p['w'],p['h'],p['count']) for p in parts])
print('total',sum(p['count'] for p in parts))
