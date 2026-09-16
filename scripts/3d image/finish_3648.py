import json,random,sys
import numpy as np
from scipy.signal import correlate
from scipy.ndimage import binary_dilation
from pathlib import Path
out=Path('results/3648');data=json.load(open(out/'major_layout.json'))
placed=data['placements']; ids={p['id'] for p in placed}
remaining=[p for p in data['parts'] if p['id'] not in ids]
height=int(sys.argv[1]) if len(sys.argv)>1 else 78
for trial in range(10000):
 board=np.zeros((height,52),bool); placements=placed.copy()
 for p in placed:board[p['y']:p['y']+p['h'],p['x']:p['x']+p['w']] |= np.array(p['grid'])>=0
 rng=random.Random(trial)
 for p in sorted(remaining,key=lambda p:p['count']*rng.uniform(.7,1.3),reverse=True):
  mask=np.array(p['grid'])>=0
  blocked=binary_dilation(board,structure=np.ones((3,3)))
  ys,xs=np.where(correlate(blocked.astype(float),mask.astype(float),mode='valid',method='fft')<.1)
  if not len(ys):break
  k=np.argmin(ys*rng.uniform(-1,1)+xs*rng.uniform(-1,1)+np.array([rng.uniform(0,3) for _ in ys]))
  x,y=int(xs[k]),int(ys[k]);board[y:y+p['h'],x:x+p['w']] |= mask
  placements.append(dict(p,x=x,y=y))
 if len(placements)==37:
  data['placements']=placements;json.dump(data,open(out/'layout.json','w'),indent=2);print('SUCCESS',trial);break
else:print('NO FIT')
