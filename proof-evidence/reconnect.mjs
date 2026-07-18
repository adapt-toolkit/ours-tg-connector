import { spawn } from 'node:child_process';
import readline from 'node:readline';
const TSX='/home/fleet/work/dev2-migration-gap/node_modules/.bin/tsx';
const W='/tmp/dev2-proof/worker.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function mk(name,unit){const cp=spawn(TSX,[W],{env:{...process.env,PROOF_NAME:name,OURS_TG_UNIT_DIR:unit},stdio:['pipe','pipe','inherit']});const w=new Map();let rdy;const rp=new Promise(r=>rdy=r);readline.createInterface({input:cp.stdout}).on('line',l=>{let m;try{m=JSON.parse(l)}catch{return}if(m.ready)return rdy(m);if(m.id&&w.has(m.id)){w.get(m.id)(m);w.delete(m.id)}});let s=0;const call=(cmd,x={})=>new Promise(r=>{const id=++s;w.set(id,r);cp.stdin.write(JSON.stringify({id,cmd,...x})+'\n')});return{call,rp,kill:()=>cp.kill('SIGKILL')}}
const OLD='/tmp/dev2-old-unit';
const A=mk('A',OLD),B=mk('B',OLD);
await A.rp; await B.rp;
// pair
const {invite}=await A.call('invite'); await B.call('add',{invite});
for(let i=0;i<15;i++){await sleep(2000);if((await B.call('contacts')).count&&(await A.call('contacts')).count)break;}
console.log('paired. pre-route A->B =', (await A.call('send',{text:'pre'})).route);
// both upgrade
await A.call('advertise'); await B.call('advertise');
console.log('after advertise (no reconnect), driving sweep 6 rounds...');
let route='box';
for(let i=0;i<6&&route!=='e2e';i++){await A.call('sweep');await B.call('sweep');await sleep(1500);route=(await A.call('send',{text:'x'+i})).route;}
console.log('route after advertise+sweep (ordinary traffic) =', route, '(expect box — caps not refreshed)');
// RECONNECT: re-pair (fresh invite carries current caps incl cap_e2e_migrate)
console.log('RE-PAIRING (fresh invite exchange to refresh caps)...');
const {invite:inv2}=await B.call('invite'); await A.call('add',{invite:inv2});
await sleep(4000);
await A.call('notifies');await B.call('notifies');
for(let i=0;i<20&&route!=='e2e';i++){await A.call('sweep');await B.call('sweep');await sleep(1500);route=(await A.call('send',{text:'y'+i})).route;}
const ev=[...(await A.call('notifies')).notifies,...(await B.call('notifies')).notifies];
console.log('route after RE-PAIR+sweep =', route, '(expect e2e if reconnect refreshes caps)');
console.log('migration_active:', ev.filter(e=>e.event==='migration_active').length, 'e2e_app_send:', ev.filter(e=>e.event==='e2e_app_send').length);
A.kill();B.kill();process.exit(0);
