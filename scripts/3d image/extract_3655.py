from PIL import Image,ImageDraw
import numpy as np,json
from pathlib import Path
from scipy.ndimage import label,find_objects
OUT=Path('results/3655');OUT.mkdir(exist_ok=True)
im=Image.open('C:/Users/z5308/Desktop/Img 2/IMG_3655.JPG').convert('RGB');a=np.array(im)
pitch=25
regions=[('back',155,1060,30,30),('wave_1',180,1895,28,25),('wave_2',168,2626,30,24),('curl_3',180,3317,21,12),('wave_3',155,3642,30,12),('curl_4',177,4060,11,6),('wave_4',177,4235,29,8),('small_curl',202,4485,12,7),('blue_small',577,4535,4,2),('white_small',527,4585,11,3),('wide_base',83,4795,30,7),('side_white',858,4795,4,6),('long_connector',158,5160,7,18),('small_connector',358,5385,6,9),('small_blocks',458,5085,15,18)]
codes=['H2','C13','C6','C8','D4','G12','G11','H19','H3','H5']
refs=[(252,902),(314,902),(374,902),(436,902),(498,902),(559,902),(620,902),(682,902),(743,902),(804,902)]
colors=np.array([np.median(a[y-2:y+3,x-3:x+4].reshape(-1,3),axis=0) for x,y in refs]);print(dict(zip(codes,colors.tolist())))
bg=np.median(a[1830:1845,940:955].reshape(-1,3),axis=0).astype(float);print('background',bg)
parts=[]
for name,x0,y0,w,h in regions:
 grid=np.full((h,w),-1,int)
 for r in range(h):
  for c in range(w):
   if name=='small_blocks' and r>=12 and c<2:continue
   x=round(x0+(c+.5)*pitch);y=round(y0+(r+.5)*pitch)
   pix=a[y-7:y+8,x-7:x+8].reshape(-1,3).astype(float);med=np.median(pix,axis=0)
   ray=255-bg;t=np.clip(((med-bg)*ray).sum()/(ray*ray).sum(),0,.4)
   if np.linalg.norm(bg+t*ray-med)<13:continue
   rays=255-colors;alpha=np.clip(((med-colors)*rays).sum(axis=1)/np.maximum((rays*rays).sum(axis=1),1),0,.35)
   grid[r,c]=(np.linalg.norm(colors+alpha[:,None]*rays-med,axis=1)+alpha*10).argmin()
   if med.max()-med.min()<12 and med.mean()<215:
    # Low-brightness interior samples recover grey beads beneath the pale watermark.
    grey=np.percentile(pix,25,axis=0)
    indices=[8,9];grid[r,c]=indices[np.linalg.norm(colors[indices]-grey,axis=1).argmin()]
 labs,n=label(grid>=0,structure=np.ones((3,3)))
 for i,s in enumerate(find_objects(labs),1):
  rr,cc=s;g=grid[s].copy();g[labs[s]!=i]=-1
  parts.append(dict(id=len(parts)+1,region=name,source=[x0+cc.start*pitch,y0+rr.start*pitch],grid=g.tolist(),w=g.shape[1],h=g.shape[0],count=int((g>=0).sum())))
 crop=im.crop((x0-3,y0-3,x0+w*pitch+3,y0+h*pitch+3));draw=ImageDraw.Draw(crop)
 for r,c in zip(*np.where(grid>=0)):
  x=3+c*pitch;y=3+r*pitch;draw.rectangle((x+6,y+6,x+18,y+18),fill=tuple(colors[grid[r,c]].astype(int)),outline='red')
 crop.save(OUT/f'verify_{name}.png')
json.dump(dict(codes=codes,colors=colors.tolist(),parts=parts),open(OUT/'extracted.json','w'),indent=2)
print([(p['id'],p['region'],p['w'],p['h'],p['count']) for p in parts]);print('total',sum(p['count'] for p in parts))
