from pathlib import Path
s=Path('scripts/pack_3648.cjs').read_text()
s=s.replace('ps=input.parts,n=ps.length','ps=input.parts.slice(0,7),n=ps.length')
s=s.replace('let best=Infinity,bx,by,start=Date.now();',"let init=JSON.parse(fs.readFileSync('results/3648/best_partial.json')).parts;let best=Infinity,bx=init.slice(0,7).map(p=>p.x),by=init.slice(0,7).map(p=>p.y),start=Date.now();")
s=s.replace('if(run%5&&bx)','if(run%3&&bx)').replace('run%3===0?120','run%3===0?500').replace('run<300','run<300').replace('results/3648/layout.json','results/3648/major_layout.json').replace("'results/3648/best_partial.json',JSON.stringify","'results/3648/major_partial.json',JSON.stringify")
Path('scripts/pack_major_3648.cjs').write_text(s)

