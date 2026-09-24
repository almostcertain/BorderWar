'use strict';
// Headless per-tick sim profiler. Runs the same sim the goldens check and
// reports tick-time percentiles, total time per sim phase / AI method, and
// the worst ticks with what dominated them. Measurement only — never feeds
// anything back into the sim.
//   node tools/sim-profile.js [ticks=6000] [map=world|small|medium|large] [seed=12345] [bots=8] [tribes=12]
const { fs, path, vm, root, loader } = require('./split-common');
const TICKS=+process.argv[2]||6000, MAP=process.argv[3]||'world', SEED=+process.argv[4]||12345;
const BOTS=+process.argv[5]||8, TRIBES=+process.argv[6]||12;
const names=loader();
const sources=names.slice(0,names.indexOf('ai')+1).filter(n=>!['render','input','ui','radial','main'].includes(n)).map(n=>`js/${n}.js`);
const ctx=vm.createContext({console});
for(const f of sources) vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),ctx,{filename:f});
const {Game,GameMap,Hash,AI,TribeAI}=vm.runInContext('({Game,GameMap,Hash,AI,TribeAI})',ctx);
const cfg=MAP==='world'?{map:'world',seed:SEED,bots:BOTS,tribes:TRIBES,ticks:TICKS}:{size:MAP,seed:SEED,bots:BOTS,tribes:TRIBES,ticks:TICKS};
if(MAP==='world'){const m=JSON.parse(fs.readFileSync(path.join(root,'maps/world/manifest.json')));const b=fs.readFileSync(path.join(root,'maps/world/map.bin'));GameMap.worldData={manifest:m.map,bytes:new Uint8Array(b.buffer,b.byteOffset,b.length)};}
const t0=performance.now();
Game.init(Hash._syntheticGameStartInfo(cfg),0);
console.log('init ms',(performance.now()-t0).toFixed(0),'map',GameMap.width,'x',GameMap.height);
Game.chooseSpawn(Hash.firstLegalSpawn());
// wrap phases
const phases=['updateConstruction','resolveOpposingFronts','stepAttack','checkAnnexations','stepBoats','updateFactoryStations','stepTrains','updatePortTrade','stepTradeShips','stepWarships','stepShells','stepSAMs','stepNukes','updateDiplomacy','setOwner','seaPath','goldPerSecond','maxTroops'];
const cur={};let depth={};
function wrap(obj,name,label){const o=obj[name];if(typeof o!=='function')return;obj[name]=function(...a){if(depth[label]){return o.apply(this,a);}depth[label]=1;const s=performance.now();try{return o.apply(this,a);}finally{cur[label]=(cur[label]||0)+performance.now()-s;depth[label]=0;}};}
for(const p of phases) wrap(Game,p,p);
wrap(AI,'update','AI.update');wrap(TribeAI,'update','TribeAI.update');
// wrap AI sub-methods
for(const k of Object.keys(AI)) if(typeof AI[k]==='function'&&k!=='update') wrap(AI,k,'AI.'+k);
const rows=[];
for(let t=1;t<=TICKS&&Game.winnerId===null;t++){for(const k in cur)delete cur[k];const s=performance.now();Game.tick();const dt=performance.now()-s;rows.push({t,dt,br:{...cur}});}
const dts=rows.map(r=>r.dt).sort((a,b)=>a-b);
const q=p=>dts[Math.floor(p*(dts.length-1))].toFixed(2);
console.log('ticks',rows.length,'mean',(dts.reduce((a,b)=>a+b)/dts.length).toFixed(2),'p50',q(.5),'p95',q(.95),'p99',q(.99),'max',q(1));
const tot={};for(const r of rows)for(const k in r.br)tot[k]=(tot[k]||0)+r.br[k];
console.log('TOTAL ms by phase (nested AI.* included in AI.update):');
for(const [k,v] of Object.entries(tot).sort((a,b)=>b[1]-a[1]).slice(0,25))console.log(' ',k.padEnd(28),v.toFixed(0));
console.log('WORST 20 ticks:');
for(const r of [...rows].sort((a,b)=>b.dt-a.dt).slice(0,20)){const top=Object.entries(r.br).filter(([k])=>!k.startsWith('AI.')||k==='AI.update').sort((a,b)=>b[1]-a[1]).slice(0,3).map(([k,v])=>k+'='+v.toFixed(1)).join(' ');const ai=Object.entries(r.br).filter(([k])=>k.startsWith('AI.')&&k!=='AI.update').sort((a,b)=>b[1]-a[1]).slice(0,2).map(([k,v])=>k+'='+v.toFixed(1)).join(' ');console.log(' t'+r.t,r.dt.toFixed(1)+'ms |',top,'|',ai);}
// spikes > 16ms count
console.log('ticks >16ms:',rows.filter(r=>r.dt>16).length,' >33ms:',rows.filter(r=>r.dt>33).length,' >50ms:',rows.filter(r=>r.dt>50).length);
