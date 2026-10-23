import test from 'node:test';
import assert from 'node:assert/strict';
import { load, same } from './harness.mjs';

const Model = () => load()('plugins/panel/model');

test('panel: parse, serialize and keep the file\'s indentation', () => {
	const M = Model();
	assert.match(M.parse('{').error, /^Invalid JSON/);
	assert.equal(M.parse('[1]').error, 'A panel file must contain a JSON object.');
	same(M.parse('').doc, {});
	assert.equal(M.detectIndent('{\n\t"a": 1\n}'), '\t');
	assert.equal(M.detectIndent('{\n    "a": 1\n}'), 4);
	assert.equal(M.detectIndent('{"a":1}'), 2);
	assert.equal(M.serialize({ a: 1 }, '\t'), '{\n\t"a": 1\n}\n');
});

test('panel: values, defaults, options and how values read', () => {
	const M = Model();
	const doc = { values: { heater: 21 }, extra: 'kept' };
	assert.equal(M.valueOf(doc, { id: 'heater', default: 20 }), 21);
	assert.equal(M.valueOf(doc, { id: 'fan', default: 50 }), 50);
	const mode = { type: 'select', options: ['home', { value: 'vac', label: 'Vacation' }] };
	same(M.optionsOf(mode), [{ value: 'home', label: 'home' }, { value: 'vac', label: 'Vacation' }]);
	assert.equal(M.describe(mode, 'vac'), 'Vacation');
	assert.equal(M.describe({ type: 'number', unit: '°C' }, 21), '21 °C');
	assert.equal(M.describe({ type: 'toggle' }, false), 'off');
	same(M.withValue(doc, 'fan', 30), { values: { heater: 21, fan: 30 }, extra: 'kept' });
	same(doc.values, { heater: 21 }, 'withValue does not mutate');
});

test('panel: validation per control type', () => {
	const { validate } = Model();
	const heater = { type: 'number', min: 15, max: 28 };
	assert.equal(validate(heater, 21), null);
	assert.equal(validate(heater, 30), 'Must be at most 28.');
	assert.equal(validate(heater, NaN), 'Enter a number.');
	assert.equal(validate({ type: 'number', integer: true }, 1.5), 'Must be a whole number.');
	assert.equal(validate({ type: 'toggle' }, 'yes'), 'Must be on or off.');
	assert.equal(validate({ type: 'select', options: ['a'] }, 'b'), 'Not one of the options.');
	assert.equal(validate({ type: 'text', required: true }, ' '), 'Required.');
	assert.equal(validate({ type: 'text', pattern: 'https?://.+' }, 'ftp://x'), 'Not in the expected format.');
	assert.equal(validate({ type: 'text', pattern: 'https?://.+' }, 'https://x'), null);
	assert.match(validate({ type: 'text', pattern: '(' }, 'x'), /pattern is invalid/);
	assert.equal(validate({ type: 'gizmo' }, { any: 1 }), null);
});

// Not built in by default, so this checks the plugins themselves: text also
// claims these files, which is why the README lists panel before text.
test('panel: the plugin claims *.panel.json and *.status.json, which text would also take', () => {
	const require = load();
	const Panel = require('plugins/panel'), Text = require('plugins/text');
	for (const f of ['pc.panel.json', 'dir/X.PANEL.JSON', 'pc.status.json']) {
		assert.ok(Panel.canHandle(f), f);
		assert.ok(Text.canHandle(f), f);
	}
	assert.ok(!Panel.canHandle('package.json'));
});

test('panel: commands get sortable ids, a rev each, and old ones are pruned', () => {
	const M = Model();
	const now = new Date('2026-10-22T07:22:27.158Z');
	const id = M.newCommandId(now, () => 0.5);
	assert.equal(id, 'c-20261022T072227-iiiiii');

	let doc = { rev: 4, values: {} };
	doc = M.addCommand(doc, 'download', { url: 'u' }, now, 'c-1');
	same(doc.queue, [{ id: 'c-1', command: 'download', args: { url: 'u' }, at: '2026-10-22T07:22:27.158Z', rev: 5 }]);
	assert.equal(doc.rev, 5);

	const old = { queue: [{ id: 'a', at: '2026-10-01T00:00:00Z' }, { id: 'b', at: '2026-10-20T00:00:00Z' }, { id: 'c' }] };
	same(M.prune(old, now).queue.map(e => e.id), ['b', 'c'], 'older than 7 days dropped; entries without a time kept');
	same(M.prune({ ...old, keep_days: 30 }, now).queue.map(e => e.id), ['a', 'b', 'c']);
	const many = { queue: Array.from({ length: 60 }, (_, i) => ({ id: `e${i}`, at: now.toISOString() })) };
	assert.equal(M.prune(many, now).queue.length, 50);
	assert.equal(M.prune(many, now).queue[0].id, 'e10');
});

test('panel: liveness from the heartbeat', () => {
	const { liveness } = Model();
	const now = new Date('2026-10-22T08:10:00Z');
	const st = (updated, beat = 60) => ({ updated, heartbeat_seconds: beat });
	same(liveness(st('2026-10-22T08:09:00Z'), now), { state: 'live', age: 60 });
	assert.equal(liveness(st('2026-10-22T08:07:01Z'), now).state, 'live', '2 beats + 1 min grace');
	assert.equal(liveness(st('2026-10-22T08:05:00Z'), now).state, 'late');
	assert.equal(liveness(st('2026-10-22T07:58:00Z'), now).state, 'offline');
	assert.equal(liveness({ updated: '2026-10-22T08:00:00Z' }, now).state, 'unknown');
	assert.equal(liveness({}, now).state, 'none');
	assert.equal(liveness(null, now).state, 'none');
});

test('panel: history of one command, newest first', () => {
	const { historyOf } = Model();
	same(historyOf({ queue: [{ id: '1', command: 'a' }, { id: '2', command: 'b' }, { id: '3', command: 'a' }, 'junk'] }, 'a').map(x => x.id), ['3', '1']);
	same(historyOf({}, 'a'), []);
});

test('panel: its status file is the one of the same name', () => {
	const { statusRefOf } = load()('plugins/panel');
	assert.equal(statusRefOf('pc.panel.json'), 'pc.status.json');
	assert.equal(statusRefOf('dir/Home.PANEL.JSON'), 'Home.status.json', 'relative to the panel');
	assert.equal(statusRefOf('pc.status.json'), null);
});

test('panel: a setting as the program reports it', () => {
	const { valueState } = Model();
	const mode = { id: 'mode', type: 'select', options: ['home', 'vac'] };
	const doc = { rev: 2, values: { mode: 'home' } };
	const st = (o) => ({ values: { mode: 'vac' }, ...o });
	assert.equal(valueState(doc, null, mode).state, 'unknown');
	assert.equal(valueState(doc, st({ rev: 2, values: { mode: 'home' } }), mode).state, 'ok');
	assert.equal(valueState(doc, st({ rev: 1 }), mode).state, 'pending');
	same(valueState(doc, st({ rev: 2, errors: { mode: 'busy' } }), mode), { state: 'error', reported: 'vac', message: 'busy' });
	same(valueState(doc, st({ rev: 2 }), mode), { state: 'differs', reported: 'vac' });
	same(valueState(doc, st({}), mode), { state: 'differs', reported: 'vac' }, 'without a rev, a difference is just shown');
	assert.equal(valueState(doc, st({ accepts: { values: ['other'] } }), mode).state, 'unhandled');
	assert.equal(valueState(doc, { rev: 2, values: {} }, mode).state, 'unknown');
});

test('panel: a command\'s state', () => {
	const { commandState, commandHandled } = Model();
	const e = { id: 'c-1', command: 'backup', rev: 3 };
	assert.equal(commandState(e, null).state, 'waiting');
	assert.equal(commandState(e, { rev: 2 }).state, 'waiting');
	assert.equal(commandState(e, { rev: 3 }).state, 'no-result');
	same(commandState(e, { rev: 3, results: { 'c-1': { state: 'done', output: '' } } }), { state: 'done', result: { state: 'done', output: '' } });
	assert.equal(commandState(e, { results: { 'c-1': { state: 'running' } } }).state, 'running');
	assert.equal(commandHandled({ accepts: { commands: ['backup'] } }, 'download'), false);
	assert.equal(commandHandled({}, 'download'), true);
});
