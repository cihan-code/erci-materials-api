'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const { spawn } = require('child_process');
test('shared final HTTP plan: reads are free, config private, synthetic check isolated, report revises all jobs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-final-http-'));
  const panelFile = path.join(dir, 'panel-data.json'), counter = path.join(dir, 'calls');
  const original = JSON.stringify({ data: { jobs: [], uretimTakip: [
    { id: 7, customer_name: 'Synthetic 7', quantity: 100, status: 'Baskı/Nakışta', decoration: 'baski' },
    { id: 8, customer_name: 'Synthetic 8', quantity: 80, status: 'Dikimde', decoration: 'yok' },
    { id: 9, customer_name: 'Synthetic 9', quantity: 50, status: 'Teslim Edildi', decoration: 'yok' },
  ] } });
  fs.writeFileSync(panelFile, original);
  const script = `
    let calls=0;
    global.fetch=async (url,opts)=>{
      if(url!=='https://api.typesafe.ai/v1/systemone') throw Error('Unexpected provider');
      const {state,questions}=JSON.parse(opts.body);
      require('fs').writeFileSync(${JSON.stringify(counter)},String(++calls));
      if(JSON.stringify(state).includes('Synthetic 7')) throw Error('Customer name exposed');
      return {ok:true,json:async()=>({model:'jev-1.13.0',answers:Object.fromEntries(Object.entries(questions).map(([name,q])=>{
        const keys=Object.keys(q.criteria),chosen=keys[0];
        return [name,{type:'choice',choice:chosen,confidence:.9,probabilities:Object.fromEntries(keys.map(k=>[k,k===chosen?1:0]))}];
      }))})};
    };
    const p=require.resolve('./agent/claude');
    require.cache[p]={id:p,filename:p,loaded:true,exports:{callClaude:async()=>({model:'test',costUsd:0,text:JSON.stringify({clarification:'',entries:[{op:'print',status:'partial',remaining:5,reason:'kâğıt eksik',issue:'print_paper',evidence:'Beş adet kaldı, kâğıt eksik'}]})})}};
    require('./server');
  `;
  const port = 18000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR: dir, API_KEY: 'synthetic-merci-key', PORT: String(port),
      TYPESAFE_API_KEY: '', ANTHROPIC_API_KEY: 'test-placeholder', NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', d => logs += d); child.stderr.on('data', d => logs += d);
  const base = 'http://127.0.0.1:' + port;
  const request = async (route, body) => {
    const response = await fetch(base + '/api/agent/operations' + route, { method: body ? 'POST' : 'GET',
      headers: { 'x-api-key': 'synthetic-merci-key', 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, 200, await response.clone().text()); return response.json();
  };
  const calls = () => fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
  try {
    for (let i = 0; i < 100 && !logs.includes('uzerinde calisiyor'); i++) await new Promise(r => setTimeout(r, 30));
    assert.ok(logs.includes('uzerinde calisiyor'), logs);
    assert.equal((await fetch(base + '/api/agent/operations/plan', { method: 'POST' })).status, 401);
    let snapshot = await request(''); assert.equal(snapshot.jev.configured, false); assert.equal(calls(), 0);
    const configured = await request('/jev/config', { api_key: 'synthetic-private-typesafe-key' });
    assert.equal(configured.configured, true); assert.doesNotMatch(JSON.stringify(configured), /synthetic-private|fingerprint/i);
    assert.equal(fs.statSync(path.join(dir, 'operations/private/jev-key.json')).mode & 0o777, 0o600);
    snapshot = await request(''); assert.equal(snapshot.plan.status, 'stale'); assert.equal(calls(), 0);
    const diagnostic = await request('/jev/check', {});
    assert.equal(diagnostic.synthetic, true); assert.equal(diagnostic.saved, false); assert.equal(calls(), 1);
    assert.equal(fs.existsSync(path.join(dir, 'operations/jev-plan.json')), false);
    assert.equal((await request('')).revision, 0);
    snapshot = await request('/plan', {}); assert.equal(snapshot.plan.source, 'jev'); assert.equal(calls(), 2);
    assert.equal(snapshot.plan.considered_count, 3); assert.equal(snapshot.plan.record_count, 2);
    await request('/plan', {}); await request(''); assert.equal(calls(), 2);
    const saved = await request('/report', { record_id: 7, text: 'Beş adet kaldı, kâğıt eksik', request_id: 'http-report',
      revision: snapshot.revision, fingerprint: snapshot.records.find(r => r.record_id === 7).fingerprint });
    assert.equal(saved.saved, true); assert.equal(calls(), 3);
    assert.match(saved.snapshot.plan.decisions.find(d => d.record_id === 7).action, /kalan 5/);
    assert.equal(saved.snapshot.plan.decisions.find(d => d.record_id === 8).source, 'jev');
    assert.equal(fs.readFileSync(panelFile, 'utf8'), original);
    assert.doesNotMatch(logs, /synthetic-private-typesafe-key/);
  } finally {
    child.kill(); if (child.exitCode === null && child.signalCode === null) await new Promise(r => child.once('exit', r)); fs.rmSync(dir, { recursive: true, force: true });
  }
});
