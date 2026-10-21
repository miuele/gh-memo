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
