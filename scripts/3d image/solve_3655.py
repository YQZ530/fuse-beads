import json,sys
from pathlib import Path
import numpy as np
from scipy.signal import correlate,convolve2d
sys.path.insert(0,'results/3648/python-deps')
from ortools.sat.python import cp_model
out=Path('results/3655');data=json.load(open(out/'extracted.json'));ps=data['parts']
W,H=52,104;model=cp_model.CpModel();xs=[];ys=[]
for p in ps:
 xs.append(model.new_int_var(0,W-p['w'],f'x{p["id"]}'));ys.append(model.new_int_var(0,H-p['h'],f'y{p["id"]}'))
for i,p in enumerate(ps):
 for j,q in enumerate(ps[i+1:],i+1):
  a=(np.array(p['grid'])>=0).astype(float);b=(np.array(q['grid'])>=0).astype(float)
  table=np.rint(correlate(a,convolve2d(b,np.ones((3,3)),mode='full'),mode='full',method='fft')).astype(int)
  dx=model.new_int_var(-(W-p['w']),W-q['w'],f'dx{i}_{j}');dy=model.new_int_var(-(H-p['h']),H-q['h'],f'dy{i}_{j}')
  model.add(dx==xs[j]-xs[i]);model.add(dy==ys[j]-ys[i])
  forbidden=[(int(c-q['w']),int(r-q['h'])) for r,c in zip(*np.where(table>0))]
  model.add_forbidden_assignments([dx,dy],forbidden)
height=model.new_int_var(30,H,'height');model.add_max_equality(height,[ys[i]+p['h'] for i,p in enumerate(ps)])
model.minimize(height)
solver=cp_model.CpSolver();solver.parameters.max_time_in_seconds=50;solver.parameters.num_search_workers=8;solver.parameters.log_search_progress=True
status=solver.solve(model);print('STATUS',solver.status_name(status),flush=True)
if status in (cp_model.OPTIMAL,cp_model.FEASIBLE):
 data['placements']=[dict(p,x=solver.value(xs[i]),y=solver.value(ys[i])) for i,p in enumerate(ps)]
 data['rows']=solver.value(height);json.dump(data,open(out/'layout.json','w'),indent=2)
 print('HEIGHT',data['rows'],flush=True)
