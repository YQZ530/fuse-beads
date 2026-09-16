import sys,json,time
sys.path.insert(0,'results/3648/python-deps')
from ortools.sat.python import cp_model
from pathlib import Path
out=Path('results/3648'); d=json.load(open(out/'packing_tables.json')); ps=d['parts'][:int(sys.argv[1]) if len(sys.argv)>1 else 10]
height=int(sys.argv[2]) if len(sys.argv)>2 else 78
model=cp_model.CpModel();xs=[];ys=[]
for p in ps:
 xs.append(model.new_int_var(0,52-p['w'],f'x{p["id"]}'));ys.append(model.new_int_var(0,height-p['h'],f'y{p["id"]}'))
for i,p in enumerate(ps):
 for j,q in enumerate(ps[i+1:],i+1):
  dx=model.new_int_var(-(52-p['w']),52-q['w'],f'dx{i}_{j}')
  dy=model.new_int_var(-(height-p['h']),height-q['h'],f'dy{i}_{j}')
  model.add(dx==xs[j]-xs[i]);model.add(dy==ys[j]-ys[i])
  table=d['tables'][f'{i},{j}'];forbidden=[]
  for r,row in enumerate(table):
   for c,v in enumerate(row):
    if v:forbidden.append((c-q['w'],r-q['h']))
  model.add_forbidden_assignments([dx,dy],forbidden)
seed=json.load(open(out/'best_partial.json'))['parts']
for i in range(len(ps)):
 model.add_hint(xs[i],seed[i]['x']);model.add_hint(ys[i],seed[i]['y'])
solver=cp_model.CpSolver();solver.parameters.max_time_in_seconds=180;solver.parameters.num_search_workers=8
solver.parameters.log_search_progress=True
status=solver.solve(model)
print('STATUS',solver.status_name(status),flush=True)
if status in (cp_model.OPTIMAL,cp_model.FEASIBLE):
 data=json.load(open(out/'extracted.json'));data['placements']=[dict(p,x=solver.value(xs[i]),y=solver.value(ys[i])) for i,p in enumerate(ps)]
 json.dump(data,open(out/'major_layout.json','w'),indent=2)
