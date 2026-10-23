import test from 'node:test';
import assert from 'node:assert/strict';
import { load, same } from './harness.mjs';

test('merge: one balanced hunk per change, local side first (C2)', () => {
	const Merge = load()('actions/merge');
	// The parts jsdiff 8 returns for remote "a\nb\n" vs local "a\nB\n".
	const Diff = { diffLines: () => [{ value: 'a\n' }, { removed: true, value: 'b\n' }, { added: true, value: 'B\n' }] };
	assert.equal(Merge.diffMarkers(Diff, 'a\nb\n', 'a\nB\n'), 'a\n<<<<<<< LOCAL\nB\n=======\nb\n>>>>>>> REMOTE\n');

	// Two separate changes, a one-sided addition, and no trailing newline.
	const parts = [
		{ removed: true, value: 'r1\n' }, { added: true, value: 'l1\n' },
		{ value: 'same\n' },
		{ added: true, value: 'only local\n' },
		{ value: 'tail\n' },
		{ removed: true, value: 'end' }, { added: true, value: 'END' },
	];
	assert.equal(Merge.diffMarkers({ diffLines: () => parts }, '', ''), [
		'<<<<<<< LOCAL', 'l1', '=======', 'r1', '>>>>>>> REMOTE',
		'same',
		'<<<<<<< LOCAL', 'only local', '=======', '>>>>>>> REMOTE',
		'tail',
		'<<<<<<< LOCAL', 'END', '=======', 'end', '>>>>>>> REMOTE', '',
	].join('\n'));

	assert.equal(Merge.wholeFileMarkers('R', 'L'), '<<<<<<< LOCAL\nL\n=======\nR\n>>>>>>> REMOTE');
});

test('file list: filtering, deep search and icons', () => {
	const FileList = load()('ui/fileList');
	const notes = () => [
		{ filename: 'b.md', content: 'x foo foo' },
		{ filename: 'a.txt', content: 'foo' },
		{ filename: 'pic.png', content: {} },
	];
	same(FileList.filterNotes(notes(), '', false).map(n => n.filename), ['a.txt', 'b.md', 'pic.png']);
	same(FileList.filterNotes(notes(), '.TXT', false).map(n => n.filename), ['a.txt']);
	same(FileList.filterNotes(notes(), 'foo', true).map(n => [n.filename, n.matchCount]), [['b.md', 2], ['a.txt', 1]]);

	const icon = FileList.getFileIcon;
	assert.equal(icon({ is_folder: true }), '📁');
	assert.equal(icon({ is_folder: true, is_mount_point: true }), '🗂️');
	assert.equal(icon({ remote_sha: null }), '');
	assert.equal(icon({ remote_sha: 's', last_synced_sha: 's' }), '🟢');
	assert.equal(icon({ remote_sha: 's', last_synced_sha: 's', is_dirty: true }), '🟡');
	assert.equal(icon({ remote_sha: 's2', last_synced_sha: 's' }), '⬇️');
	assert.equal(icon({ remote_sha: 's2', last_synced_sha: 's', is_dirty: true }), '🟡⬇️');
});

test('sync: push uploads the stored note and marks it clean (all collaborators faked)', async () => {
	const db = new Map([['a.md', { filename: 'a.md', content: 'héllo', last_synced_sha: 'old', is_dirty: true }]]);
	const puts = [];
	const statuses = [];
	const require = load({ fakes: {
		'model/config': { activeWorkspace: { askForCommitMsg: false }, activeKeychain: { provider: 'github' } },
		'storage/notesDb': { get: async (k) => db.get(k), put: async (n) => db.set(n.filename, n) },
		'remote/sync': { putFile: async (...args) => { puts.push(args); return { content: { sha: 'new' } }; } },
		'ui/editor': { currentFilename: () => 'a.md' },
		'ui/status': { show: (text) => statuses.push(text) },
		'ui/fileList': { render() {} },
		'ui/refs': { searchBar: { value: '' } },
		'lib/tabChannel': { SIDEBAR_REFRESH: 'SIDEBAR_REFRESH', post() {} },
	} });
	const Sync = require('actions/sync');
	const { utoa } = require('lib/encoding');

	await Sync.push();
	same(puts, [['a.md', utoa('héllo'), 'old', null]]);
	same(db.get('a.md'), { filename: 'a.md', content: 'héllo', last_synced_sha: 'new', is_dirty: false, remote_sha: 'new' });
	assert.equal(statuses.at(-1), 'Successfully pushed a.md.');

	await Sync.push();
	assert.equal(statuses.at(-1), 'a.md is already up to date.');
	assert.equal(puts.length, 1);
});

test('files: a debounced edit is saved into the file and workspace it was typed in (A1)', async () => {
	const dbs = { ws1: new Map([['a.md', { filename: 'a.md', content: 'old' }]]), ws2: new Map() };
	let active = 'ws1';
	let open = 'a.md';
	const posted = [];
	const require = load({ fakes: {
		'storage/notesDb': {
			get dbName() { return active; },
			get: async (k, name = active) => dbs[name].get(k),
			put: async (n, name = active) => dbs[name].set(n.filename, n),
		},
		'ui/editor': { currentFilename: () => open },
		'ui/fileList': { render() {} },
		'ui/refs': { searchBar: { value: '' } },
		'lib/tabChannel': { LOCAL_EDIT: 'LOCAL_EDIT', post: (m) => posted.push(m) },
	} });
	const Files = require('actions/files');

	Files.handleTyping('typed in a');
	active = 'ws2';            // the user switches workspace and opens another file
	open = 'b.md';
	await Files.flushPendingEdit();

	same(dbs.ws1.get('a.md'), { filename: 'a.md', content: 'typed in a', is_dirty: true });
	assert.equal(dbs.ws2.size, 0);
	same(posted, [{ type: 'LOCAL_EDIT', dbName: 'ws1', filename: 'a.md' }], 'other tabs are told which workspace (E1)');
	await Files.flushPendingEdit();  // nothing pending: a no-op
});

test('cross-tab: an edit freezes the same file only in the same workspace (E1)', () => {
	let handler;
	let frozen = 0;
	const require = load({ fakes: {
		'model/config': { activeWorkspace: { dbName: 'ws1' } },
		'lib/tabChannel': { LOCAL_EDIT: 'LOCAL_EDIT', SIDEBAR_REFRESH: 'SIDEBAR_REFRESH', onMessage: (h) => { handler = h; }, post() {} },
		'ui/editor': { currentFilename: () => 'a.md', freeze: () => { frozen++; return true; } },
		'ui/fileList': { render() {} },
		'ui/status': { show() {} },
	} });
	require('app/crossTab').install();
	handler({ type: 'LOCAL_EDIT', dbName: 'ws2', filename: 'a.md' });
	handler({ type: 'LOCAL_EDIT', dbName: 'ws1', filename: 'b.md' });
	assert.equal(frozen, 0);
	handler({ type: 'LOCAL_EDIT', dbName: 'ws1', filename: 'a.md' });
	assert.equal(frozen, 1);
});

test('notesDb: onWrite reports each write with its database, until unsubscribed', async () => {
	const DB = load({ fakes: { 'model/config': { activeWorkspace: { dbName: 'active' } } } })('storage/notesDb');
	DB._run = async () => {};
	const seen = [];
	const off = DB.onWrite((w) => seen.push(w));
	await DB.put({ filename: 'a.md' });
	await DB.put({ filename: 'b.md' }, 'other');
	await DB.delete('c.md');
	await DB.clear();
	off();
	await DB.put({ filename: 'd.md' });
	same(seen, [
		{ dbName: 'active', filename: 'a.md' }, { dbName: 'other', filename: 'b.md' },
		{ dbName: 'active', filename: 'c.md' }, { dbName: 'active', filename: null },
	]);
});

// A store and editor shared by the actions under test, with a remote whose
// calls stay pending until the test releases them.
const raceRig = (note, remote) => {
	const db = new Map([[note.filename, note]]);
	const statuses = [];
	const prompts = [];
	const activated = [];
	let release;
	const network = new Promise(r => { release = r; });
	const require = load({
		fakes: {
			'model/config': { activeWorkspace: { askForCommitMsg: false }, activeKeychain: { provider: 'github' } },
			'storage/notesDb': { dbName: 'ws1', get: async (k) => structuredClone(db.get(k)), put: async (n) => db.set(n.filename, structuredClone(n)) },
			'remote/sync': {
				putFile: async () => { await network; return { content: { sha: 'pushed' } }; },
				getFile: async () => { await network; return remote; },
			},
			'ui/editor': { currentFilename: () => note.filename, activate: (f, c) => activated.push(c) },
			'ui/status': { show: (text) => statuses.push(text) },
			'ui/fileList': { render() {} },
			'ui/refs': { searchBar: { value: '' } },
			'lib/tabChannel': { SIDEBAR_REFRESH: 'SIDEBAR_REFRESH', LOCAL_EDIT: 'LOCAL_EDIT', post() {} },
		},
		globals: { prompt: (msg) => { prompts.push(msg); return 'i'; } },
	});
	return { db, statuses, prompts, activated, release, Sync: require('actions/sync'), Files: require('actions/files') };
};

test('sync: typing during a push keeps the new text and leaves the note dirty (A2)', async () => {
	const rig = raceRig({ filename: 'a.md', content: 'v1', last_synced_sha: 's0', remote_sha: 's0', is_dirty: true });
	const pushing = rig.Sync.push();
	await new Promise(r => setTimeout(r, 0));
	rig.Files.handleTyping('v1 v2');   // still inside the debounce when the upload returns
	rig.release();
	await pushing;

	same(rig.db.get('a.md'), { filename: 'a.md', content: 'v1 v2', last_synced_sha: 'pushed', remote_sha: 'pushed', is_dirty: true });
	assert.match(rig.statuses.at(-1), /Edits made during the upload are not pushed yet/);
});

test('sync: typing during a pull is not overwritten by the remote copy (A2)', async () => {
	const remote = { content: btoa('v1'), sha: 's1' };
	const rig = raceRig({ filename: 'a.md', content: 'v1', last_synced_sha: 's0', remote_sha: 's0', is_dirty: false }, remote);
	const pulling = rig.Sync.pull();
	await new Promise(r => setTimeout(r, 0));
	rig.Files.handleTyping('v1 v2');
	rig.release();
	await pulling;

	// The prompt answers 'i' (keep local).
	assert.equal(rig.prompts.length, 1, 'the edit is treated as a local change');
	same(rig.db.get('a.md'), { filename: 'a.md', content: 'v1 v2', last_synced_sha: 's1', remote_sha: 's1', is_dirty: true });
	same(rig.activated, ['v1 v2']);
});

test('sync: refresh warns in the status bar when the tree was truncated (D6)', async () => {
	const statuses = [];
	const require = load({ fakes: {
		'storage/notesDb': { get: async () => undefined, put: async () => {} },
		'remote/sync': { getTree: async () => ({ tree: [{ path: 'a.md', type: 'blob', sha: '1' }], truncated: true }) },
		'ui/status': { show: (text, isError) => statuses.push([text, !!isError]) },
		'ui/fileList': { render() {} },
		'ui/refs': { searchBar: { value: '' } },
		'lib/tabChannel': { SIDEBAR_REFRESH: 'SIDEBAR_REFRESH', post() {} },
	} });
	await require('actions/sync').refreshTree();
	const [text, isError] = statuses.at(-1);
	assert.match(text, /File list incomplete/);
	assert.equal(isError, true, 'stays visible');
});

test('pins: rekey moves a tree\'s pins to its new signature, merging without duplicates (D4)', () => {
	const config = { treePins: { 'github|h|o|r|main': ['a.md', 'b.md'], 'github|h|o|r|dev': ['b.md', 'c.md'] }, saved: 0, savePins() { this.saved++; } };
	let renders = 0;
	const require = load({ fakes: { 'model/config': config, 'ui/pins': { render: () => renders++ } } });
	const Pins = require('actions/pins');

	Pins.rekey('github|h|o|r|main', 'github|h|o|r2|main');
	same(config.treePins, { 'github|h|o|r|dev': ['b.md', 'c.md'], 'github|h|o|r2|main': ['a.md', 'b.md'] });
	Pins.rekey('github|h|o|r2|main', 'github|h|o|r|dev');
	same(config.treePins, { 'github|h|o|r|dev': ['b.md', 'c.md', 'a.md'] });
	assert.equal(config.saved, 2);
	assert.equal(renders, 2);

	Pins.rekey('github|nothing', 'github|else');   // no pins: nothing to do
	assert.equal(config.saved, 2);
});
