import json,numpy as np
from PIL import Image,ImageDraw
from pathlib import Path
d=json.load(open('results/3649/extracted.json'));a=np.array(Image.open('C:/Users/z5308/Desktop/Img 2/IMG_3649.JPG')).astype(float);cols=np.array(d['colors']);dif=[];sus=[]
for p in d['parts']:
 for r,row in enumerate(p['grid']):
  for c,v in enumerate(row):
   if v<0:continue
   x=round(p['source'][0]+(c+.5)*23.35);y=round(p['source'][1]+(r+.5)*23.35);pix=a[y-7:y+8,x-7:x+8].reshape(-1,3);votes=((pix[:,None,:]-cols[None,:,:])**2).sum(2).argmin(1);b=np.bincount(votes,minlength=12);win=b.argmax()
   if win!=v:dif.append([p['id'],r,c,d['codes'][v],d['codes'][win]])
   if (p['id']==12 and r<5 and v==1) or (p['id'] in (10,11) and v==5) or (p['id']==12 and 8<=r<=14 and c>=14 and v==5):sus.append((p['id'],r,c,d['codes'][v],x,y,np.median(pix,axis=0).tolist()))
print('majority disagreements',dif);print('inspect',sus)
im=Image.new('RGB',(len(sus)*160,200),'white');dr=ImageDraw.Draw(im)
src=Image.fromarray(a.astype('uint8'))
for i,s in enumerate(sus):
 pid,r,c,code,x,y,med=s;im.paste(src.crop((x-14,y-14,x+14,y+14)).resize((140,140)),(i*160,35));dr.text((i*160,5),f'{pid} r{r}c{c} {code}',fill='black')
im.save('results/3649/suspicious.png')
import xml.etree.ElementTree as ET
root=ET.parse('results/3649/girl-with-pearl-earring-52x60.svg').getroot()
g=next(g for g in root if g.attrib.get('id')=='color-codes');print('Label count',len(g))
