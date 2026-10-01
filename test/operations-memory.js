'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { learn, reminders } = require('../agent/operations/memory');
function observation(id, record_id) { return { id, record_id, date: '2026-10-02', entries: [
  { op: 'print', status: 'partial', issue: 'print_paper', evidence: '5 baskı kağıdı eksik' },
] }; }
test('distinct jobs count, not repeated reports; one event is not a rule', () => {
  let journal = { events: [observation('1', 1), observation('2', 1)], rules: {} };
  assert.equal(learn(journal)[0].samples, 1);
  assert.equal(learn(journal)[0].status, 'observing');
  journal.events.push(observation('3', 2), observation('4', 3));
  assert.equal(learn(journal)[0].status, 'suggested');
  assert.equal(reminders({ status: 'Kesimde' }, 'baski', [], learn(journal)).length, 0);
  journal.rules.print_paper = { status: 'accepted' };
  const knowledge = learn(journal);
  assert.equal(reminders({ status: 'Kesimde' }, 'baski', [], knowledge).length, 1);
  assert.equal(reminders({ status: 'Kesimde' }, 'nakis', [], knowledge).length, 0);
  assert.equal(reminders({ status: 'Dikimde' }, 'baski', [], knowledge).length, 0);
  assert.equal(reminders({ status: 'Kesimde' }, 'baski', [{ op: 'print', status: 'completed' }], knowledge).length, 0);
  journal.events[3].voided = 'now';
  assert.equal(learn(journal)[0].status, 'observing');
  assert.equal(reminders({ status: 'Kesimde' }, 'baski', [], learn(journal)).length, 0);
});
