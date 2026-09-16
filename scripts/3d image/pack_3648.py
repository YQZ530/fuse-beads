import json, random, time
import numpy as np
from scipy.signal import correlate
from scipy.ndimage import binary_dilation
from pathlib import Path
out=Path('results/3648')
data=json.load(open(out/'extracted.json'))
parts=data['parts']; W,H=52,78
best=0; start=time.time()
for attempt in range(15000):
 board=np.zeros((H,W),bool); placements=[]
 # Large parts first, varying which irregular outlines share space.
 rng=random.Random(attempt)
 order=sorted(parts,key=lambda p: p['count']*rng.uniform(.65,1.4),reverse=True)
 for p in order:
  g=np.array(p['grid']); mask=g>=0
  blocked=binary_dilation(board,structure=np.ones((3,3)))
  collision=correlate(blocked.astype(float),mask.astype(float),mode='valid',method='fft')
  ys,xs=np.where(collision<.1)
  if not len(ys): break
  # Compact placement; occasionally reverse the horizontal preference.
  height=np.maximum(ys+p['h'],max([q['y']+q['h'] for q in placements],default=0))
  score=height* rng.uniform(0,2)+ys*rng.uniform(.1,1)+xs*rng.uniform(-1,1)
  score += np.array([rng.uniform(0,5) for _ in ys])
  k=score.argmin(); y,x=int(ys[k]),int(xs[k])
  board[y:y+p['h'],x:x+p['w']] |= mask
  placements.append(dict(p,x=x,y=y))
 if len(placements)>best:
  best=len(placements); print(attempt,'placed',best,'/',len(parts),flush=True)
 if len(placements)==len(parts):
  data['placements']=placements
  json.dump(data,open(out/'layout.json','w'),indent=2)
  print('SUCCESS',attempt, 'height',max(q['y']+q['h'] for q in placements),'seconds',time.time()-start,flush=True)
  break
else: print('NO FIT')
