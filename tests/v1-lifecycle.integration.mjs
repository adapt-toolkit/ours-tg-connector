// Real built connector + installed V1 SDK/CLI. External Telegram transport is blocked.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { attachOursClient } from '@ours.network/sdk/client';
const sleep = ms => new Promise(done => setTimeout(done, ms));
const root = mkdtempSync(join(tmpdir(), 'telegram-v1-'));
const daemonState = join(root, 'daemon'), tgState = join(root, 'telegram'), credentials = join(root, 'credentials');
for (const dir of [daemonState, tgState, credentials]) mkdirSync(dir, { mode: 0o700 });
const credentialPath = join(credentials, 'token'), daemonConfig = join(root, 'daemon-config.json');
const instanceId = randomUUID();
const hmac = process.argv.includes('--hmac');
async function port() { const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const n=server.address().port;await new Promise(done=>server.close(done));return n; }
const daemonPort = await port(), controlPort = await port();
const endpoint = `http://127.0.0.1:${daemonPort}`, controlUrl = `http://127.0.0.1:${controlPort}`;
const cli = resolve('node_modules/@ours.network/cli/dist/cli.js');
const env = Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('OURS_')));
const daemonEnv = { ...env, OURS_CONFIG:daemonConfig, OURS_STATE_DIR:daemonState, OURS_PORT:String(daemonPort),
  OURS_DAEMON_ID:instanceId, OURS_API_VISIBILITY:'owner', OURS_BROKER_URL:'wss://invalid.local/none' };
writeFileSync(daemonConfig, JSON.stringify({ stateDir:daemonState, port:daemonPort, apiTokenDeliveryFiles:[credentialPath] }), { mode:0o600 });
if (!process.argv.includes('--provision')) writeFileSync(join(tgState,'bots.json'),JSON.stringify({v:1,bots:{fixture:{name:'fixture',token:'1:synthetic-fixture',username:'fixture_bot',createdAt:new Date(0).toISOString()}}}),{mode:0o600});
const connectorEnv = { ...env, V1_PROVISION_BOT: process.argv.includes('--provision') ? '1' : '', OURS_TG_CONFIG:join(root,'missing-tg-config.json'), OURS_TG_STATE_DIR:tgState,
  OURS_TG_DAEMON_URL:endpoint, OURS_TG_DAEMON_ID:instanceId, OURS_TG_DAEMON_CREDENTIAL_PATH:credentialPath,
  OURS_TG_CONTROL_PORT:String(controlPort), OURS_TG_POLL_TIMEOUT:'1', OURS_TG_FETCH_RETRIES:'0' };
function launch(args, childEnv, audit=false) {
  const child=spawn(process.execPath,args,{env:childEnv,stdio:['ignore','pipe','pipe']});
  const done=once(child,'exit');let output='',line='';const requests=[];
  child.stdout.on('data',chunk=>{output=(output+chunk).slice(-18000);if(audit){line+=chunk;let index;while((index=line.indexOf('\n'))>=0){const text=line.slice(0,index);line=line.slice(index+1);if(text.startsWith('V1_HTTP '))requests.push(JSON.parse(text.slice(8)));}}});
  child.stderr.on('data',chunk=>{output=(output+chunk).slice(-18000);});
  return {child,done,requests,get output(){return output;}};
}
async function stop(run, signal='SIGTERM') {
  if(!run || run.child.exitCode!==null || run.child.signalCode!==null)return;
  run.child.kill(signal);const timer=setTimeout(()=>run.child.kill('SIGKILL'),20_000);
  try {await run.done;} finally {clearTimeout(timer);}
}
async function waitFor(label, run, fn, timeout=180_000) {
  const end=Date.now()+timeout;let last;
  while(Date.now()<end){
    if(run && (run.child.exitCode!==null || run.child.signalCode!==null))throw new Error(`${label}: process exited\n${run.output}`);
    try {const value=await fn();if(value)return value;} catch(error){last=error;}
    await sleep(100);
  }
  throw new Error(`${label}: timed out; ${last ?? ''}\n${run?.output ?? ''}`);
}
let daemon, connector, control, sibling;
const watchdog=setTimeout(()=>{daemon?.child.kill('SIGKILL');connector?.child.kill('SIGKILL');process.exit(124);},600_000);
async function startDaemon(){
  daemon=launch([cli,'daemon','serve'],daemonEnv);
  await waitFor('daemon selection',daemon,async()=>{const r=await fetch(endpoint+'/selection',{signal:AbortSignal.timeout(500)});return r.ok&&(await r.json()).instanceId===instanceId;});
}
const provisionEntry = process.argv.includes('--provision');
const cliEntry = process.argv[2] === 'cli';
console.log(`Telegram V1 integration entry: ${cliEntry ? 'CLI serve' : 'direct connector'}`);
async function startConnector(){
  const entry = cliEntry ? [resolve('dist/cli.js'), 'serve'] : [process.env.V1_CONNECTOR_ENTRY ?? resolve('dist/connector.js')];
  connector=launch(['--import',resolve('tests/fixtures/v1-block-telegram.mjs'),...entry],connectorEnv,true);
  await waitFor('built connector startup',connector,async()=>{const r=await fetch(controlUrl+'/health',{signal:AbortSignal.timeout(500)});return r.ok;},45_000);
}
async function request(path, method='GET', body){
  const r=await fetch(controlUrl+path,{method,headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10_000)});
  const data=await r.json();assert(r.ok,`${method} ${path}: ${JSON.stringify(data)}\n${connector.output}`);return data;
}
const meta=name=>JSON.parse(readFileSync(join(tgState,name,'connection.json'),'utf8'));
const names=async()=> (await control.listIdentities()).map(x=>x.name).sort();
const routeNames=['RouteOne','RouteTwo'];
const tokenHash=()=>createHash('sha256').update(readFileSync(credentialPath,'utf8').trim()).digest('hex');
function access(operation, ...args) {
  const result = spawnSync(process.execPath, [cli, 'config', operation, '--config', daemonConfig, ...args, '--json'], { env:daemonEnv, encoding:'utf8', timeout:30_000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
try {
  if (hmac) {
    access('access-init');
    access('access-issue', '--output', credentialPath);
  }
  await startDaemon();
  if (!hmac) copyFileSync(join(daemonState,'daemon-token'),credentialPath);
  control=await attachOursClient({endpoint,expectedInstanceId:instanceId,credentialPath,sessionMode:'external',leaseToken:randomUUID(),env:{}});
  await control.createRootIdentity({name:'FixtureRoot',bio:'',exposeLocal:false,localAutoAccept:true,skipIfRootExists:false});
  sibling=await attachOursClient({endpoint,expectedInstanceId:instanceId,credentialPath,sessionMode:'external',leaseToken:randomUUID(),env:{}});
  await sibling.createTemporaryIdentity({name:'SiblingTemp',bio:'',exposeLocal:false,localAutoAccept:true});
  if (provisionEntry) writeFileSync(join(tgState, 'provision.json'), JSON.stringify({
    bots: [{ name: 'fixture', botToken: '1:synthetic-fixture' }],
    connections: routeNames.map((name, index) => ({ name, botName: 'fixture', chatId: String(100 + index), label: 'V1 fixture', bio: '', payloadMode: 'plain' })),
  }), { mode: 0o600 });
  await startConnector();
  const provisionOutput = provisionEntry ? readFileSync(join(tgState, 'provision-output.json'), 'utf8') : null;
  const cids=[];
  for(const [index,name] of routeNames.entries()){
    const result=provisionEntry ? JSON.parse(provisionOutput).connections.find(row => row.name === name).result : await request('/connections','POST',{name,botName:'fixture',chatId:String(100+index),label:'V1 fixture',bio:'',payloadMode:'plain'});cids.push(result.cid);
  }
  const owners=routeNames.map(name=>meta(name).leaseToken);assert(owners.every(Boolean));assert.notEqual(owners[0],owners[1]);
  async function routes(){const list=(await request('/connections')).connections;assert.deepEqual(list.map(x=>x.name).sort(),routeNames);for(let i=0;i<2;i++)assert.equal(list.find(x=>x.name===routeNames[i]).cid,cids[i]);return list;}
  await routes();
  assert(connector.requests.some(x=>owners.includes(x.owner)&&x.mode==='external'&&x.status===200));
  console.log('PASS built connector attaches by HTTP identity/current credential; two routes have independent external owners and real CIDs');
  const originalToken=readFileSync(credentialPath,'utf8').trim();
  if (hmac) {
    await stop(daemon);
    assert.equal(access('access-replace', '--confirm').status, 'replaced');
    access('access-issue', '--output', credentialPath, '--replace');
    await startDaemon();
  } else {
    assert.equal(access('token-update').status, 'complete');
  }
  const updatedHash=tokenHash();assert.notEqual(updatedHash,createHash('sha256').update(originalToken).digest('hex'));
  const denied=await fetch(endpoint+'/identities',{headers:{'x-ours-api-token':originalToken}});assert.equal(denied.status,401);
  await routes();assert.deepEqual(routeNames.map(name=>meta(name).leaseToken),owners);
  for(const owner of owners)assert(connector.requests.some(x=>x.owner===owner&&x.credential===updatedHash&&x.status===200),'running route must authenticate with automatically replaced token');
  console.log(`PASS ${hmac ? 'HMAC replacement and reissue' : 'official automatic token-update'} refreshes both running route clients; stale token denied and owner IDs unchanged`);
  const firstBoot=(await control.version({startup:true})).startup.bootId;
  const restartAt=Date.now();await stop(daemon);await startDaemon();
  assert.notEqual((await control.version({startup:true})).startup.bootId,firstBoot);
  await routes();assert.deepEqual(routeNames.map(name=>meta(name).leaseToken),owners);
  await waitFor('both real route notification watches after daemon restart',connector,async()=>owners.every(owner=>connector.requests.some(x=>x.at>=restartAt&&x.owner===owner&&x.path.includes('/notifications')&&x.status===200&&x.credential===updatedHash)),75_000);
  console.log('PASS daemon restart preserves both route owners/CIDs; both actual notification watches recover');
  await stop(connector);assert.equal(connector.child.exitCode,0,connector.output);assert.equal(connector.child.signalCode,null,'shutdown must finish without forced kill');
  assert.deepEqual(await names(),['FixtureRoot','RouteOne','RouteTwo','SiblingTemp']);
  assert(routeNames.every(name=>!meta(name).leaseToken),'acknowledged terminal release must not reuse retired route owner');
  for(let i=0;i<2;i++){
    const old=await attachOursClient({endpoint,expectedInstanceId:instanceId,credentialPath,sessionMode:'external',leaseToken:owners[i],env:{}});
    try {await assert.rejects(()=>old.chooseIdentity({name:routeNames[i]}),error=>error.code==='BINDING_REASSIGNED');} finally {await old.close();}
  }
  console.log('PASS SIGTERM awaits terminal release, preserves permanent routes and sibling, and retires exact old route owners');
  await startConnector();await routes();const replacements=routeNames.map(name=>meta(name).leaseToken);
  assert(replacements.every((owner,i)=>owner&&owner!==owners[i]));assert.notEqual(replacements[0],replacements[1]);
  console.log('PASS normal connector restart uses distinct fresh owners for the same persisted route identities');
  if (provisionEntry) {
    assert.equal(readFileSync(join(tgState, 'provision-output.json'), 'utf8'), provisionOutput, 'repeat must preserve issued invites');
    await stop(connector);
    const before = readFileSync(join(tgState, 'bots.json'), 'utf8');
    writeFileSync(join(tgState, 'provision.json'), JSON.stringify({ bots: [{ name: 'fixture', botToken: '1:synthetic-conflict' }], connections: [] }), { mode: 0o600 });
    connector = launch(['--import', resolve('tests/fixtures/v1-block-telegram.mjs'), resolve('dist/cli.js'), 'serve'], connectorEnv);
    await waitFor('conflicting provision startup exits', null, () => connector.child.exitCode !== null);
    assert.notEqual(connector.child.exitCode, 0);
    assert.match(connector.output, /conflict/);
    assert.equal(readFileSync(join(tgState, 'bots.json'), 'utf8'), before);
    console.log('PASS optional startup provisioning, retained invite results on repeat and conflicting input refuses before readiness');
  }
} finally {
  // Cleanup is test-owned and cannot hide the first assertion failure.
  for(const cleanup of [()=>stop(connector),()=>sibling?.releaseLease(),()=>sibling?.close(),()=>control?.close(),()=>stop(daemon)]){
    try {await cleanup();} catch(error){console.error('fixture cleanup:',error.message);}
  }
  clearTimeout(watchdog);rmSync(root,{recursive:true,force:true});
}
