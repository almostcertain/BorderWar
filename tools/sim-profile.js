'use strict';
// Headless per-tick sim profiler. Runs the same sim the goldens check and
// reports tick-time percentiles, total time per sim phase / AI method, and
// the worst ticks with what dominated them. Measurement only — never feeds
// anything back into the sim.
//   node tools/sim-profile.js [ticks=6000] [map=world|small|medium|large] [seed=12345] [bots=8] [tribes=12] [--fog] [--drill=TICK]
// --drill=TICK places The Drill (docs/battle-royale.md) at that tick, on the
// nation-owned tile nearest the map's top-left corner (a large start radius:
// the worst case for the circle's sweep), paid for by injected gold.
// --fog runs the match with fog of war on (docs/fog-of-war.md), to compare
// against the same match without it.
const { fs, path, vm, root, loader } = require('./split-common');
const TICKS=+process.argv[2]||6000, MAP=process.argv[3]||'world', SEED=+process.argv[4]||12345;
const BOTS=+process.argv[5]||8, TRIBES=+process.argv[6]||12;
const FOG=process.argv.includes('--fog');
const DRILL_ARG=process.argv.find(a=>a.startsWith('--drill='));const DRILL_AT=DRILL_ARG?+DRILL_ARG.slice(8):0;
const names=loader();
const sources=names.slice(0,names.indexOf('ai')+1).filter(n=>!['render','input','ui','radial','main'].includes(n)).map(n=>`js/${n}.js`);
const ctx=vm.createContext({console});
for(const f of sources) vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),ctx,{filename:f});
const {Game,GameMap,Hash,AI,TribeAI}=vm.runInContext('({Game,GameMap,Hash,AI,TribeAI})',ctx);
const cfg=MAP==='world'?{map:'world',seed:SEED,bots:BOTS,tribes:TRIBES,ticks:TICKS}:{size:MAP,seed:SEED,bots:BOTS,tribes:TRIBES,ticks:TICKS};
if(FOG)cfg.fogOfWar=true;
if(MAP==='world'){const m=JSON.parse(fs.readFileSync(path.join(root,'maps/world/manifest.json')));const b=fs.readFileSync(path.join(root,'maps/world/map.bin'));GameMap.worldData={manifest:m.map,bytes:new Uint8Array(b.buffer,b.byteOffset,b.length)};}
const t0=performance.now();
Game.init(Hash._syntheticGameStartInfo(cfg),0);
console.log('init ms',(performance.now()-t0).toFixed(0),'map',GameMap.width,'x',GameMap.height,'fog',Game.fog);
Game.chooseSpawn(Hash.firstLegalSpawn());
// wrap phases
const phases=['updateConstruction','resolveOpposingFronts','stepAttack','checkAnnexations','stepBoats','updateFactoryStations','stepTrains','updatePortTrade','stepTradeShips','stepWarships','stepShells','stepSAMs','stepNukes','updateDiplomacy','setOwner','seaPath','goldPerSecond','maxTroops','visionStamp','visionAllianceFormed','stepScouts','seaTowardRun','stepDrill','drillSweep','drillKillUnits'];
const cur={};let depth={};
function wrap(obj,name,label){const o=obj[name];if(typeof o!=='function')return;obj[name]=function(...a){if(depth[label]){return o.apply(this,a);}depth[label]=1;const s=performance.now();try{return o.apply(this,a);}finally{cur[label]=(cur[label]||0)+performance.now()-s;depth[label]=0;}};}
for(const p of phases) wrap(Game,p,p);
wrap(AI,'update','AI.update');wrap(TribeAI,'update','TribeAI.update');
// wrap AI sub-methods
for(const k of Object.keys(AI)) if(typeof AI[k]==='function'&&k!=='update') wrap(AI,k,'AI.'+k);
const rows=[];
// Fog of war: how many ticks each Scout order stands still waiting for its
// route (its own search plus its turn: one search runs at a time, for the
// whole match). Counted outside the timed part of the tick.
const waiting=new Map(),waits=[];let scoutPeak=0;
function scoutWaits(){scoutPeak=Math.max(scoutPeak,Game.scouts.length);const live=new Set();for(const s of Game.scouts){live.add(s.id);if(s.routing&&s.pos>=s.path.length-1)waiting.set(s.id,(waiting.get(s.id)||0)+1);else if(waiting.has(s.id)){waits.push(waiting.get(s.id));waiting.delete(s.id);}}for(const id of waiting.keys())if(!live.has(id))waiting.delete(id);}
function placeDrill(){let best=-1,bd=Infinity;const w=GameMap.width;for(const p of Game.players){if(!p.alive||p.isTribe)continue;for(const t of p.tiles){const x=t%w,y=(t-x)/w,d=x*x+y*y;if(d<bd){bd=d;best=t;}}}if(best<0)return;const id=GameMap.owner[best];Game.players[id].gold+=Game.DRILL_COST;Game.placeDrill(id,best);const d=Game.drill;console.log('drill placed tick',Game.ticks,'by',id,'at',d.cx+','+d.cy,'r0',d.r0,'start/end',d.startTick,d.endTick);}
for(let t=1;t<=TICKS&&Game.winnerId===null;t++){if(t===DRILL_AT)placeDrill();for(const k in cur)delete cur[k];const s=performance.now();Game.tick();const dt=performance.now()-s;rows.push({t,dt,br:{...cur}});if(FOG)scoutWaits();}
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
// Memory at the end of the run, and the fog-of-war vision arrays on their own.
// Run node with --expose-gc for a heapUsed figure taken after a collection.
if(typeof gc==='function')gc();
const mem=process.memoryUsage(),mb=n=>(n/1048576).toFixed(2);
const vision=['visionGroupOf','visionCells','visionStamped','visionShare','visionMet','visionCount'].reduce((sum,k)=>sum+(Game[k]?Game[k].byteLength:0),0);
console.log('memory MB: heapUsed',mb(mem.heapUsed),'arrayBuffers',mb(mem.arrayBuffers),'| vision arrays',mb(vision),'groups',Game.visionGroups,'words',Game.visionWords,'cells',Game.visionCellsW*Game.visionCellsH);
if(FOG){waits.sort((a,b)=>a-b);const w=p=>waits.length?waits[Math.floor(p*(waits.length-1))]:0;console.log('scout route waits (ticks): orders',waits.length,'mean',(waits.reduce((a,b)=>a+b,0)/Math.max(1,waits.length)).toFixed(2),'p50',w(.5),'p95',w(.95),'p99',w(.99),'max',w(1),'| peak scouts afloat',scoutPeak);}
if(DRILL_AT&&Game.drill){const d=Game.drill;const ms=rows.filter(r=>r.t>d.placedTick&&r.br.stepDrill!==undefined).map(r=>r.br.stepDrill).sort((a,b)=>a-b);const dq=p=>ms[Math.floor(p*(ms.length-1))].toFixed(2);if(ms.length)console.log('stepDrill ms over',ms.length,'ticks: mean',(ms.reduce((a,b)=>a+b)/ms.length).toFixed(3),'p50',dq(.5),'p99',dq(.99),'max',dq(1),'| winner',Game.winnerId,'at',((Game.ticks-d.placedTick)/Game.TICKS_PER_SEC/60).toFixed(2),'min after placement');}
console.log('final hash',Hash.compute(),'ticks',Game.ticks);
