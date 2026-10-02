'use strict';
// Real Express routes and the real interpretation adapter, with only the paid
// provider stubbed. All files and credentials are synthetic and temporary.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const { spawn } = require('child_process');

test('HTTP report -> plan -> learned rule -> undo; auth, retries and call budgets', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operations-http-'));
  const data = { jobs: [], uretimTakip: [7, 8, 9].map(id => ({ id, customer_name: 'Synthetic ' + id,
    quantity: 100, status: 'Baskı/Nakışta', decoration: 'baski' })) };
  const panelFile = path.join(dir, 'panel-data.json');
  const original = JSON.stringify({ data, updatedAt: 'fixture' });
  fs.writeFileSync(panelFile, original);
  const port = 18000 + Math.floor(Math.random() * 10000);
  const script = `
    const p=require.resolve('./agent/claude');
    let calls=0;
    require.cache[p]={id:p,filename:p,loaded:true,exports:{callClaude:async opts=>{
      if(opts.opType!=='production_feedback'||opts.maxTokens!==1500||opts.maxAttempts!==1) throw Error('budget');
      const state=JSON.parse(opts.user);
      if(!state.selected_record.name.startsWith('Synthetic ')||'quantity' in state.selected_record||'panel' in state) throw Error('context');
      const text=state.report;
      require('fs').writeFileSync(${JSON.stringify(path.join(dir, 'calls'))}, String(++calls));
      return {text:JSON.stringify({clarification:'',entries:[{op:'print',status:'partial',remaining:5,
        reason:'baskı kâğıdı eksik',issue:'print_paper',evidence:text}]}),model:'test',costUsd:0};
    }}};
    require('./server');
  `;
  const child = spawn(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR: dir, API_KEY: 'test-only-key', PORT: String(port),
      ANTHROPIC_API_KEY: 'test-placeholder', NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', d => { logs += d; }); child.stderr.on('data', d => { logs += d; });
  const base = 'http://127.0.0.1:' + port;
  const request = (route, body) => fetch(base + '/api/agent/operations' + route, {
    method: body ? 'POST' : 'GET', headers: { 'x-api-key': 'test-only-key', 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try {
    for (let i = 0; i < 100 && !logs.includes('uzerinde calisiyor'); i++) await new Promise(r => setTimeout(r, 30));
    assert.ok(logs.includes('uzerinde calisiyor'), logs);
    assert.ok(!(await fetch(base + '/api/agent/operations')).ok);
    let snapshot = await (await request('')).json();
    for (const id of [7, 8, 9]) {
      const body = { record_id: id, request_id: 'report-' + id, text: 'Beş adet kaldı, baskı kâğıdı eksik',
        revision: snapshot.revision, fingerprint: snapshot.records.find(r => r.record_id === id).fingerprint };
      const res = await request('/report', body); assert.equal(res.status, 200);
      const saved = await res.json(); assert.equal(saved.saved, true);
      assert.match(saved.snapshot.records.find(r => r.record_id === id).revision.action, /kalan 5/);
      snapshot = saved.snapshot;
      const again = await (await request('/report', body)).json(); assert.equal(again.reused, true);
    }
    assert.equal(fs.readFileSync(path.join(dir, 'calls'), 'utf8'), '3');
    assert.equal(snapshot.knowledge[0].samples, 3);
    assert.equal(snapshot.knowledge[0].status, 'suggested');
    snapshot = await (await request('/rule', { revision: snapshot.revision, issue: 'print_paper', status: 'accepted' })).json();
    assert.equal(snapshot.records[0].reminders.length, 1);
    snapshot = await (await request('/undo', { revision: snapshot.revision, event_id: 'report-9' })).json();
    assert.equal(snapshot.knowledge[0].samples, 2);
    assert.equal(snapshot.records[0].reminders.length, 0);
    assert.equal(fs.readFileSync(panelFile, 'utf8'), original);
  } finally {
    child.kill();
    if (child.exitCode === null && child.signalCode === null) await new Promise(r => child.once('exit', r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
