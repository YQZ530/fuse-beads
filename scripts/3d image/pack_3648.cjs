const fs=require('fs');
const data=JSON.parse(fs.readFileSync('results/3648/extracted.json'));
const input=JSON.parse(fs.readFileSync('results/3648/packing_tables.json'));
const ps=input.parts,n=ps.length,w=ps.map(p=>p.w),h=ps.map(p=>p.h);
const tables=Array.from({length:n},()=>Array(n));
for(let i=0;i<n;i++)for(let j=i+1;j<n;j++){
 const t=input.tables[`${i},${j}`]; tables[i][j]={v:Int32Array.from(t.flat()),w:t[0].length,h:t.length};
}
function cost(i,j,xi,yi,xj,yj){
 if(i>j)return cost(j,i,xj,yj,xi,yi);
 const t=tables[i][j],dx=xj-xi+w[j],dy=yj-yi+h[j];
 return dx>=0&&dx<t.w&&dy>=0&&dy<t.h?t.v[dy*t.w+dx]:0;
}
let best=Infinity,bx,by,start=Date.now();
const ri=n=>Math.floor(Math.random()*n);
for(let run=0;run<300;run++){
 let xs=ps.map(p=>ri(53-p.w)),ys=ps.map(p=>ri(79-p.h));
 if(run%5&&bx){xs=bx.slice();ys=by.slice();}
 let total=0;
 for(let i=0;i<n;i++)for(let j=i+1;j<n;j++)total+=cost(i,j,xs[i],ys[i],xs[j],ys[j]);
 for(let step=0;step<500000;step++){
  const temp=Math.max(.1,(run%3===0?120:run%3===1?35:8)*Math.pow(1-step/500000,3));
  let i=ri(n),old=0;
  for(let j=0;j<n;j++)if(j!==i)old+=cost(i,j,xs[i],ys[i],xs[j],ys[j]);
  if(old===0&&Math.random()<.95)continue;
  let x,y;
  if(Math.random()<.15){x=ri(53-w[i]);y=ri(79-h[i]);}
  else{const r=Math.random()<.7?1:6; x=Math.min(52-w[i],Math.max(0,xs[i]+ri(2*r+1)-r));y=Math.min(78-h[i],Math.max(0,ys[i]+ri(2*r+1)-r));}
  let val=0;for(let j=0;j<n;j++)if(j!==i)val+=cost(i,j,x,y,xs[j],ys[j]);
  const delta=val-old;
  if(delta<=0||Math.random()<Math.exp(-delta/temp)){xs[i]=x;ys[i]=y;total+=delta;}
  if(total<best){best=total;bx=xs.slice();by=ys.slice();}
  if(total===0){data.placements=ps.map((p,i)=>({...p,x:xs[i],y:ys[i]}));fs.writeFileSync('results/3648/layout.json',JSON.stringify(data));console.log('SUCCESS',run,step,(Date.now()-start)/1000);process.exit();}
 }
 console.log(run,best,(Date.now()-start)/1000);
 fs.writeFileSync('results/3648/best_partial.json',JSON.stringify({best,parts:ps.map((p,i)=>({...p,x:bx[i],y:by[i]}))}));
}
