import test from 'node:test';
import assert from 'node:assert/strict';
import { load, same } from './harness.mjs';

test('merge: current conflict-marker format (known issue, review §1.6)', () => {
	const Merge = load()('actions/merge');
	// The parts jsdiff 8 returns for remote "a\nb\n" vs local "a\nB\n".
	const Diff = { diffLines: () => [{ value: 'a\n' }, { removed: true, value: 'b\n' }, { added: true, value: 'B\n' }] };
	assert.equal(Merge.diffMarkers(Diff, 'a\nb\n', 'a\nB\n'), 'a\nb\n>>>>>>> REMOTE\n<<<<<<< LOCAL\nB\n\n=======\n');
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
	const require = load({ fakes: {
		'storage/notesDb': {
			get dbName() { return active; },
			get: async (k, name = active) => dbs[name].get(k),
			put: async (n, name = active) => dbs[name].set(n.filename, n),
		},
		'ui/editor': { currentFilename: () => open },
		'ui/fileList': { render() {} },
		'ui/refs': { searchBar: { value: '' } },
		'lib/tabChannel': { LOCAL_EDIT: 'LOCAL_EDIT', post() {} },
	} });
	const Files = require('actions/files');

	Files.handleTyping('typed in a');
	active = 'ws2';            // the user switches workspace and opens another file
	open = 'b.md';
	await Files.flushPendingEdit();

	same(dbs.ws1.get('a.md'), { filename: 'a.md', content: 'typed in a', is_dirty: true });
	assert.equal(dbs.ws2.size, 0);
	await Files.flushPendingEdit();  // nothing pending: a no-op
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
