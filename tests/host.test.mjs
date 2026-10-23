import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { load, moduleFiles, relative, same } from './harness.mjs';

// One repo mounted three times (root, docs/, shared/), plus another repo.
const rig = () => {
	const gh = (rootDir, dbName, repo = 'notes') => ({ keychainId: 'kc', host: 'api.github.com', owner: 'o', repo, branch: 'main', rootDir, dbName });
	const config = {
		keychains: { kc: { provider: 'github' } },
		workspaces: { root: gh('', 'db_root'), docs: gh('docs', 'db_docs'), shared: gh('shared/', 'db_shared'), other: gh('', 'db_other', 'elsewhere') },
		activeWorkspaceId: 'docs',
		get activeWorkspace() { return this.workspaces[this.activeWorkspaceId]; },
		get activeKeychain() { return this.keychains.kc; },
	};
	const dbs = {
		db_root: new Map([['top.png', { content: 'TOP' }], ['dir', { is_folder: true }], ['link.symlink', { content: '{}' }]]),
		db_docs: new Map([['img/a.png', { content: 'A', is_dirty: true }], ['my pic.png', { content: 'PIC' }]]),
		db_shared: new Map([['logo.png', { content: 'LOGO' }]]),
		db_other: new Map([['top.png', { content: 'OTHER' }]]),
	};
	const listeners = new Set();
	const statuses = [];
	const db = {
		get: async (filename, dbName) => dbs[dbName].get(filename),
		onWrite: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
	};
	const require = load({ fakes: { 'model/config': config, 'storage/notesDb': db, 'ui/status': { show: (t) => statuses.push(t) } } });
	const write = (dbName, filename) => listeners.forEach(cb => cb({ dbName, filename }));
	return { config, dbs, listeners, statuses, write, Host: require('actions/host') };
};

const wait = (ms) => new Promise(r => setTimeout(r, ms));

test('host: reads stored files of the repo, read-only', async () => {
	const { Host, config } = rig();
	const host = Host.create('a.md');
	const read = host.api.read;

	same(await read('img/a.png'), { content: 'A', isDirty: true }, 'own mount');
	config.activeWorkspaceId = 'other';    // a workspace switch does not redirect the host
	same(await read('../top.png'), { content: 'TOP', isDirty: false }, 'parent mount, not the other repo');
	same(await read('/top.png'), { content: 'TOP', isDirty: false }, 'from the repo root');
	same(await read('../shared/logo.png'), { content: 'LOGO', isDirty: false }, 'child mount');
	assert.equal(await read('nope.png'), null, 'not stored');
	assert.equal(await read('../dir'), null, 'a folder is not a file');
	same(await read('my%20pic.png'), { content: 'PIC', isDirty: false }, 'percent-encoding is decoded');

	await assert.rejects(read('../../up.png'), /outside the repository/, '.. above the repo root');
	await assert.rejects(read('../link.symlink'), /symlinks are not followed/);
	await assert.rejects(read('https://x.org/i.png'), /not a path/);
	same(host.reads(), ['img/a.png', '../top.png', '/top.png', '../shared/logo.png', 'nope.png', '../dir', 'my pic.png'], 'what was read, for the app');
	assert.equal('write' in host.api, false);
});

test('host: changes to files read are coalesced; others are ignored', async () => {
	const { Host, write } = rig();
	const host = Host.create('a.md');
	await host.api.read('img/a.png');
	await host.api.read('../shared/logo.png');
	await host.api.read('my pic.png');
	await host.api.read('later.png');      // missing now, watched anyway
	const calls = [];
	host.api.onChange((e) => calls.push(e.paths.sort()));

	write('db_docs', 'img/a.png');
	write('db_shared', 'logo.png');
	write('db_docs', 'img/a.png');
	write('db_docs', 'a.md');              // the open file itself
	write('db_docs', 'unread.png');
	write('db_other', 'img/a.png');        // same name, another workspace
	await wait(Host.COALESCE_MS + 50);
	same(calls, [['../shared/logo.png', 'img/a.png']]);

	write('db_docs', 'later.png');         // a missing file is stored
	await wait(Host.COALESCE_MS + 50);
	same(calls[1], ['later.png']);

	write('db_docs', null);                // a cleared cache touches everything read from it
	await wait(Host.COALESCE_MS + 50);
	same(calls[2], ['img/a.png', 'later.png', 'my pic.png']);

	Host.changed('db_shared', 'logo.png'); // a write in another tab
	await wait(Host.COALESCE_MS + 50);
	same(calls[3], ['../shared/logo.png']);
});

test('host: inert after dispose', async () => {
	const { Host, write, listeners } = rig();
	const host = Host.create('a.md');
	await host.api.read('img/a.png');
	let called = 0;
	host.api.onChange(() => called++);
	write('db_docs', 'img/a.png');
	host.dispose();
	await wait(Host.COALESCE_MS + 50);
	assert.equal(called, 0, 'a pending change is dropped');
	assert.equal(await host.api.read('img/a.png'), null);
	assert.equal(listeners.size, 0, 'unsubscribed from the store');
	Host.changed('db_docs', 'img/a.png');
});

test('lib/path: resolveWithin stays inside the tree', () => {
	const { resolveWithin } = load()('lib/path');
	assert.equal(resolveWithin('docs/a.md', 'img/x.png'), 'docs/img/x.png');
	assert.equal(resolveWithin('docs/a.md', './../x.png'), 'x.png');
	assert.equal(resolveWithin('docs/a.md', '/x/y.png'), 'x/y.png');
	assert.equal(resolveWithin('a.md', 'b//c.png'), 'b/c.png');
	assert.equal(resolveWithin('docs/a.md', '../../x.png'), null);
	assert.equal(resolveWithin('a.md', '..'), null);
});

test('structure: plugins reach other files and the network only through the host', () => {
	for (const file of moduleFiles().filter(f => relative(f).startsWith('src/plugins/'))) {
		const src = fs.readFileSync(file, 'utf8');
		const deps = [...src.match(/^define\('[^']+',\s*\[([^\]]*)\]/m)[1].matchAll(/'([^']+)'/g)].map(d => d[1]);
		for (const dep of deps) assert.ok(!/^(storage|remote|actions)\//.test(dep), `${relative(file)} must not depend on ${dep}`);
		assert.ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|indexedDB|localStorage/.test(src), `${relative(file)} must not use the network or storage directly`);
	}
});
