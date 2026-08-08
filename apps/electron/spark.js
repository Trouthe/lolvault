const W=96,H=28,PX=3,PY=5,T=0.18;
function coords(values){
  const min=Math.min(...values),max=Math.max(...values),range=max-min;
  const iw=W-PX*2, ih=H-PY*2, mid=H/2;
  return values.map((v,i)=>({x:PX+(iw*i)/(values.length-1), y: range===0? mid : H-PY-(ih*(v-min))/range}));
}
function line(c){
  if(c.length<2) return '';
  let d=`M ${c[0].x.toFixed(2)} ${c[0].y.toFixed(2)}`;
  for(let i=0;i<c.length-1;i++){
    const p=c[i-1]??c[i], s=c[i], e=c[i+1], n=c[i+2]??e;
    d+=` C ${(s.x+(e.x-p.x)*T).toFixed(2)} ${(s.y+(e.y-p.y)*T).toFixed(2)}, ${(e.x-(n.x-s.x)*T).toFixed(2)} ${(e.y-(n.y-s.y)*T).toFixed(2)}, ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
  }
  return d;
}
const cases={
  'real spice (2307,2307,2328)':[2307,2307,2328],
  'two points':[2224,2328],
  'flat':[2300,2300,2300],
  'zigzag x10':[100,140,90,180,60,200,120,170,80,210],
  'steady decline':[300,280,255,230,200],
};
for(const [name,vals] of Object.entries(cases)){
  const c=coords(vals);
  const d=line(c);
  const ys=[], re=/([\d.]+) ([\d.]+)(?=,|$| )/g;
  const nums=d.match(/-?\d+\.?\d*/g).map(Number);
  const yvals=nums.filter((_,i)=>i%2===1);
  console.log('\n'+name);
  console.log('  path:', d.length>150? d.slice(0,150)+'…' : d);
  console.log('  NaN:', /NaN/.test(d), '| y range:', Math.min(...yvals).toFixed(1), '→', Math.max(...yvals).toFixed(1), '(viewBox 0–'+H+')');
  const over = Math.min(...yvals) < -2 || Math.max(...yvals) > H+2;
  console.log('  overshoot beyond viewBox:', over ? 'YES ⚠' : 'no');
}
