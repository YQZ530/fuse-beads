import json,numpy as np
from PIL import Image,ImageDraw
d=json.load(open('results/3655/extracted.json'));a=np.array(Image.open('C:/Users/z5308/Desktop/Img 2/IMG_3655.JPG')).astype(float);cols=np.array(d['colors']);diffs=[]
for p in d['parts']:
 for r,row in enumerate(p['grid']):
  for c,v in enumerate(row):
   if v<0:continue
   x=round(p['source'][0]+(c+.5)*25);y=round(p['source'][1]+(r+.5)*25)
   corners=np.concatenate([a[y+dy-1:y+dy+2,x+dx-1:x+dx+2].reshape(-1,3) for dy in (-2,2) for dx in (-2,2)])
   med=np.median(corners,axis=0);rays=255-cols;alpha=np.clip(((med-cols)*rays).sum(1)/np.maximum((rays*rays).sum(1),1),0,.35)
   win=(np.linalg.norm(cols+alpha[:,None]*rays-med,axis=1)+alpha*10).argmin()
   if win!=v:diffs.append((p['id'],r,c,d['codes'][v],d['codes'][win],x,y,med.tolist()))
print('Independent sample differences',len(diffs));print(diffs[:30])
if diffs:
 im=Image.new('RGB',(160*min(8,len(diffs)),185*((len(diffs)+7)//8)),'white');draw=ImageDraw.Draw(im);src=Image.fromarray(a.astype('uint8'))
 for i,(pid,r,c,old,new,x,y,med) in enumerate(diffs):
  xx=i%8*160;yy=i//8*185;im.paste(src.crop((x-13,y-13,x+13,y+13)).resize((140,140)),(xx,yy+30));draw.text((xx,yy),f'{pid} {r},{c} {old}/{new}',fill='black')
 im.save('results/3655/color-check.png')
