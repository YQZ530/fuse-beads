import json,random,time,math
import numpy as np
from scipy.signal import correlate, convolve2d
from pathlib import Path
out=Path('results/3648'); data=json.load(open(out/'extracted.json'))
ps=sorted(data['parts'],key=lambda p:p['count'],reverse=True)
n=len(ps); widths=[p['w'] for p in ps]; heights=[p['h'] for p in ps]
tables={}
for i in range(n):
 for j in range(i+1,n):
  a=(np.array(ps[i]['grid'])>=0).astype(float); b=(np.array(ps[j]['grid'])>=0).astype(float)
  b=convolve2d(b,np.ones((3,3)),mode='full')
  tables[i,j]=np.rint(correlate(a,b,mode='full',method='fft')).astype(int).tolist()
def cost(i,j,xi,yi,xj,yj):
 if i>j: return cost(j,i,xj,yj,xi,yi)
 dx=xj-xi+widths[j]; dy=yj-yi+heights[j]
 t=tables[i,j]
 return t[dy][dx] if 0<=dy<len(t) and 0<=dx<len(t[0]) else 0
json.dump({'parts':ps,'tables':{f'{i},{j}':t for (i,j),t in tables.items()}},open(out/'packing_tables.json','w'))
best=1e9; start=time.time(); rng=random.Random(3648)
for run in range(30):
 if run and run%4!=0:
  xs,ys=bestpos[0].copy(),bestpos[1].copy()
 else:
  xs=[rng.randrange(53-w) for w in widths]; ys=[rng.randrange(79-h) for h in heights]
 total=sum(cost(i,j,xs[i],ys[i],xs[j],ys[j]) for i in range(n) for j in range(i+1,n))
 for step in range(250000):
  temp= max(.15,12*(1-step/250000)**2)
  i=rng.randrange(n)
  if rng.random()<.2:
   x=rng.randrange(53-widths[i]); y=rng.randrange(79-heights[i])
  else:
   radius=1 if rng.random()<.65 else 5
   x=min(52-widths[i],max(0,xs[i]+rng.randint(-radius,radius)))
   y=min(78-heights[i],max(0,ys[i]+rng.randint(-radius,radius)))
  old=sum(cost(i,j,xs[i],ys[i],xs[j],ys[j]) for j in range(n) if j!=i)
  new=sum(cost(i,j,x,y,xs[j],ys[j]) for j in range(n) if j!=i)
  delta=new-old
  if delta<=0 or rng.random()<math.exp(-delta/temp):
   xs[i]=x; ys[i]=y; total+=delta
  if total<best:
   best=total; bestpos=(xs.copy(),ys.copy())
  if total==0:
   data['placements']=[dict(p,x=xs[i],y=ys[i]) for i,p in enumerate(ps)]
   json.dump(data,open(out/'layout.json','w'),indent=2)
   print('SUCCESS',run,step,time.time()-start,flush=True); quit()
 print('run',run,'best',best,'seconds',time.time()-start,flush=True)
