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
		'storage/notesDb': { dbName: 'w', rewriteAll: async (plan) => plan([]) },
		'model/config': { activeWorkspace: { dbName: 'w', shallow: false } },
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

// Refresh against a fake remote listing; returns the notes left and the last status.
async function refreshWith(notes, tree, { shallow = false, truncated = false, open = null } = {}) {
	const db = new Map(notes.map(n => [n.filename, { ...n }]));
	const statuses = [];
	let reset = 0;
	let transactions = 0;
	const require = load({ fakes: {
		'storage/notesDb': {
			dbName: 'w',
			rewriteAll: async (plan, dbName) => {
				transactions++;
				assert.equal(dbName, 'w');
				const changes = plan([...db.values()].map(n => ({ ...n })));
				for (const n of changes.put) db.set(n.filename, { ...n });
				for (const f of changes.delete) db.delete(f);
				return changes;
			},
		},
		'model/config': { activeWorkspace: { dbName: 'w', shallow } },
		'remote/sync': { getTree: async () => ({ tree, truncated }) },
		'ui/editor': { currentFilename: () => open, reset: () => reset++ },
		'ui/status': { show: (text) => statuses.push(text) },
		'ui/fileList': { render() {} },
		'ui/refs': { searchBar: { value: '' } },
		'lib/tabChannel': { SIDEBAR_REFRESH: 'SIDEBAR_REFRESH', post() {} },
	} });
	await require('actions/sync').refreshTree();
	assert.equal(transactions, 1, 'one read-modify-write transaction (E5)');
	return { db, status: statuses.at(-1), reset };
}

test('sync: refresh turns files deleted remotely into local-only files, and drops empty placeholders (D5)', async () => {
	const { db, status, reset } = await refreshWith([
		{ filename: 'kept.md', content: 'k', remote_sha: 'k1', last_synced_sha: 'k1', is_dirty: false },
		{ filename: 'pulled.md', content: 'p', remote_sha: 'p1', last_synced_sha: 'p1', is_dirty: false },
		{ filename: 'edited.md', content: 'e2', remote_sha: 'e1', last_synced_sha: 'e1', is_dirty: true },
		{ filename: 'placeholder.md', content: '', remote_sha: 'h1', last_synced_sha: null, is_dirty: false },
		{ filename: 'gone', content: null, remote_sha: 'g1', last_synced_sha: null, is_dirty: false, is_folder: true },
		{ filename: 'new.md', content: 'n', remote_sha: null, last_synced_sha: null, is_dirty: true },
	], [{ path: 'kept.md', type: 'blob', sha: 'k1' }], { open: 'placeholder.md' });

	for (const f of ['pulled.md', 'edited.md']) {
		const n = db.get(f);
		assert.equal(n.remote_sha, null, f);
		assert.equal(n.last_synced_sha, null, `${f}: a push creates it again`);
		assert.equal(n.is_dirty, true, `${f}: a push is not skipped as up to date`);
	}
	assert.equal(db.get('edited.md').content, 'e2');
	assert.equal(db.get('kept.md').remote_sha, 'k1');
	assert.ok(!db.has('placeholder.md') && !db.has('gone'), 'nothing local: dropped');
	assert.equal(reset, 1, 'the open placeholder is closed');
	assert.equal(db.get('new.md').is_dirty, true, 'never-pushed file untouched');
	assert.match(status, /2 files deleted remotely are now local-only/);
});

test('sync: a shallow refresh drops clean nested notes and keeps edited ones (D7); a truncated one judges nothing (D5)', async () => {
	const notes = [
		{ filename: 'sub/deep.md', content: 'd', remote_sha: 'd1', last_synced_sha: 'd1', is_dirty: false },
		{ filename: 'sub/edited.md', content: 'e2', remote_sha: 'e1', last_synced_sha: 'e1', is_dirty: true },
		{ filename: 'sub/new.md', content: 'n', remote_sha: null, last_synced_sha: null, is_dirty: true },
		{ filename: 'top.md', content: 't', remote_sha: 't1', last_synced_sha: 't1', is_dirty: false },
	];
	const shallow = await refreshWith(notes, [{ path: 'sub', type: 'folder', sha: 's' }], { shallow: true });
	assert.ok(!shallow.db.has('sub/deep.md'), 'clean nested note dropped');
	assert.equal(shallow.db.get('sub/edited.md').remote_sha, 'e1', 'edited nested note kept as it was');
	assert.ok(shallow.db.has('sub/new.md'), 'never-pushed nested note kept');
	assert.equal(shallow.db.get('top.md').remote_sha, null, 'top level is judged (D5)');
	assert.match(shallow.status, /Kept 2 files in subfolders with unpushed edits/);

	const truncated = await refreshWith(notes, [], { truncated: true });
	assert.equal(truncated.db.get('top.md').remote_sha, 't1');
	assert.equal(truncated.db.get('sub/deep.md').remote_sha, 'd1');
});

test('forest + settings: a mount below forces its parent shallow, equal roots do not, and the flag stays (D7)', () => {
	const config = {
		keychains: { k: { provider: 'github' } },
		workspaces: {
			root: { keychainId: 'k', host: 'h', owner: 'o', repo: 'r', branch: 'main', rootDir: '', shallow: false },
			root2: { keychainId: 'k', host: 'h', owner: 'o', repo: 'r', branch: 'main', rootDir: '/', shallow: false },
			other: { keychainId: 'k', host: 'h', owner: 'o', repo: 'other', branch: 'main', rootDir: 'docs', shallow: false },
		},
		saveKeychains() {}, saveWorkspaces() {},
	};
	let renders = 0;
	const require = load({ fakes: { 'model/config': config, 'ui/settings': { render: () => renders++ } } });
	const Forest = require('model/forest');
	const Settings = require('actions/settings');

	assert.equal(Forest.hasMountsBelow('root'), false, 'two mounts at / are siblings');
	assert.equal(Forest.hasMountsBelow('root2'), false);
	Settings.save();
	assert.equal(config.workspaces.root.shallow, false, 'a mount in another tree does not count');
	assert.equal(renders, 0, 'nothing forced, no re-render');

	config.workspaces.docs = { ...config.workspaces.root, rootDir: 'docs/' };
	config.workspaces.docsdeep = { ...config.workspaces.root, rootDir: 'docs-old' };
	assert.equal(Forest.hasMountsBelow('docs'), false);
	Settings.save();
	assert.equal(config.workspaces.root.shallow && config.workspaces.root2.shallow, true, 'roots with docs below are forced shallow');
	assert.equal(config.workspaces.docs.shallow || config.workspaces.docsdeep.shallow, false, 'docs-old is not below docs');
	assert.equal(renders, 1, 'settings re-rendered to show it');

	delete config.workspaces.docs;
	delete config.workspaces.docsdeep;
	Settings.save();
	assert.equal(config.workspaces.root.shallow, true, 'stays shallow when the mounts below go away');
});

test('sync: a binary pull records the sha of the bytes it downloaded, not the listed one (C6)', async () => {
	const blob = new Blob(['new bytes'], { type: 'image/png' });
	const rig = raceRig({ filename: 'a.png', content: new Blob(['old']), last_synced_sha: 's0', remote_sha: 's0', is_dirty: false }, { content: blob, sha: 's2' });
	rig.release();
	await rig.Sync.pull();
	const n = rig.db.get('a.png');
	assert.equal(await n.content.text(), 'new bytes');
	assert.equal(n.last_synced_sha, 's2');
	assert.equal(n.remote_sha, 's2');

	// Without a sha (GitHub without crypto.subtle), the listed one is kept as before.
	const rig2 = raceRig({ filename: 'b.png', content: new Blob(['old']), last_synced_sha: 's0', remote_sha: 's1', is_dirty: false }, { content: blob, sha: null });
	rig2.release();
	await rig2.Sync.pull();
	assert.equal(rig2.db.get('b.png').last_synced_sha, 's1');
});

