// The remoteStorage provider against the example server (examples/rs_server.py),
// over real HTTP on loopback. Skipped when python3 is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { load, same } from './harness.mjs';

const SERVER = new URL('../examples/rs_server.py', import.meta.url).pathname;
const hasPython = spawnSync('python3', ['--version']).status === 0;

const start = async (...extra) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'));
	const root = path.join(dir, 'root'), state = path.join(dir, 'state');
	fs.mkdirSync(path.join(root, 'notes', 'img'), { recursive: true });
	fs.writeFileSync(path.join(root, 'notes', 'todo.md'), 'Hello World\n');
	fs.writeFileSync(path.join(root, 'notes', 'img', 'plot.png'), '');
	fs.mkdirSync(path.join(root, '.git'));
	fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref\n');
	const out = spawnSync('python3', ['-I', SERVER, '--state-dir', state, '--add-token', 'test'], { encoding: 'utf8' });
	const token = out.stdout.trim().split('\n').pop();
	const port = 20000 + Math.floor(Math.random() * 20000);
	const proc = spawn('python3', ['-I', SERVER, root, '--state-dir', state, '--port', String(port), ...extra, '--quiet']);
	const base = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 50; i++) {
		try { await fetch(base + '/storage/'); break; } catch { await new Promise(r => setTimeout(r, 100)); }
	}
	return { root, token, base, stop: () => proc.kill() };
};

test('remotestorage provider against the example server', { skip: !hasPython && 'python3 not installed' }, async (t) => {
	const srv = await start();
	t.after(srv.stop);
	const Rs = load({ globals: { fetch } })('remote/remotestorage');
	const Encoding = load()('lib/encoding');
	const ws = { host: `${srv.base}/storage/`, rootDir: 'notes', shallow: false };
	const kc = { token: srv.token };

	// The listing and ETags are the ones in the spec's examples.
	same(await Rs.getTree(ws, kc), { tree: [
		{ path: 'todo.md', sha: '557db03de997c86a4a028e1ebd3a1ceb225be238', type: 'blob', size: 12 },
		{ path: 'img/plot.png', sha: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391', type: 'blob', size: 0 },
	], truncated: false });
	same(await Rs.getTree(ws, kc), (await Rs.getTree(ws, kc)), 'revalidated listing is stable');
	same((await Rs.getTree({ ...ws, rootDir: '', shallow: true }, kc)).tree.map(e => e.path), ['notes'], '.git is not listed');

	const file = await Rs.getFile('todo.md', ws, kc);
	assert.equal(Encoding.atou(file.content), 'Hello World\n');

	// Update the version we saw; a stale version is refused; create; delete.
	const put = await Rs.putFile('todo.md', Encoding.utoa('Hello World, again\n'), file.sha, null, ws, kc);
	assert.equal(put.content.sha, '7187eb193808e83540b17055665b8722d8ee2dc5');
	assert.equal(fs.readFileSync(path.join(srv.root, 'notes', 'todo.md'), 'utf8'), 'Hello World, again\n');
	await assert.rejects(Rs.putFile('todo.md', Encoding.utoa('x'), file.sha, null, ws, kc), /Please Pull first/);
	await assert.rejects(Rs.putFile('todo.md', Encoding.utoa('x'), null, null, ws, kc), /Please Pull first/);

	const made = await Rs.putFile('new dir/a#b.md', Encoding.utoa('new'), null, null, ws, kc);
	assert.equal(fs.readFileSync(path.join(srv.root, 'notes', 'new dir', 'a#b.md'), 'utf8'), 'new');
	same((await Rs.getTree(ws, kc)).tree.map(e => e.path).sort(), ['img/plot.png', 'new dir/a#b.md', 'todo.md'], 'a changed subfolder is listed again');

	// Another program edits the file: the old version no longer deletes it.
	fs.writeFileSync(path.join(srv.root, 'notes', 'new dir', 'a#b.md'), 'edited elsewhere');
	await assert.rejects(Rs.deleteFile('new dir/a#b.md', made.content.sha, ws, kc), /Please Pull first/);
	const fresh = (await Rs.getTree(ws, kc)).tree.find(e => e.path === 'new dir/a#b.md');
	await Rs.deleteFile('new dir/a#b.md', fresh.sha, ws, kc);
	assert.ok(!fs.existsSync(path.join(srv.root, 'notes', 'new dir', 'a#b.md')));

	await assert.rejects(Rs.getTree(ws, { token: 'wrong' }), /rejected the token/);
});

test('example server: preconditions, paths, Host and Origin', { skip: !hasPython && 'python3 not installed' }, async (t) => {
	const srv = await start('--allow-origin', 'https://miuele.github.io/');
	t.after(srv.stop);
	const auth = { Authorization: `Bearer ${srv.token}` };
	const status = async (p, init = {}) => (await fetch(srv.base + p, { ...init, headers: { ...auth, ...init.headers } })).status;

	assert.equal(await status('/storage/notes/todo.md', { method: 'PUT', body: 'x' }), 428, 'unconditional PUT');
	assert.equal(await status('/storage/notes/todo.md', { method: 'DELETE' }), 428, 'unconditional DELETE');
	assert.equal(await status('/storage/notes/todo.md/x', { method: 'PUT', body: 'x', headers: { 'If-None-Match': '*' } }), 409, 'document as folder');
	assert.equal(await status('/storage/.git/HEAD'), 403, '.git');
	assert.equal(await status('/storage/notes/a%00b'), 400, 'NUL in a name');   // (fetch itself resolves %2E%2E)
	assert.equal(await status('/storage/notes/', { headers: { 'If-None-Match': '"c3d7f998ccf3e63b03411e1de4475243c5df5e6b"' } }), 304, 'folder revalidation');
	assert.equal(await status('/storage/', { headers: { Origin: 'https://evil.example' } }), 403, 'origin');

	const pre = await fetch(srv.base + '/storage/notes/todo.md', { method: 'OPTIONS', headers: { Origin: 'https://miuele.github.io', 'Access-Control-Request-Method': 'PUT' } });
	assert.equal(pre.status, 204);
	assert.equal(pre.headers.get('access-control-allow-origin'), 'https://miuele.github.io');
	assert.match(pre.headers.get('access-control-allow-headers'), /If-Match/);
	const get = await fetch(srv.base + '/storage/notes/todo.md', { headers: { ...auth, Origin: 'https://miuele.github.io' } });
	assert.equal(get.headers.get('access-control-expose-headers'), 'ETag');
});

test('example server: any origin by default', { skip: !hasPython && 'python3 not installed' }, async (t) => {
	const srv = await start();
	t.after(srv.stop);
	const pre = await fetch(srv.base + '/storage/', { method: 'OPTIONS', headers: { Origin: 'http://localhost:8000', 'Access-Control-Request-Method': 'GET' } });
	assert.equal(pre.status, 204);
	assert.equal(pre.headers.get('access-control-allow-origin'), 'http://localhost:8000');
	const get = await fetch(srv.base + '/storage/', { headers: { Origin: 'http://localhost:8000' } });
	assert.equal(get.status, 401, 'a token is still required');
});

test('example server: --allow-origin must be an origin', { skip: !hasPython && 'python3 not installed' }, () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'));
	const run = (...args) => spawnSync('python3', ['-I', SERVER, root, '--state-dir', path.join(root, '.state'), ...args], { encoding: 'utf8', timeout: 5000 });
	const withPath = run('--allow-origin', 'https://miuele.github.io/gh-memo-app');
	assert.equal(withPath.status, 2);
	assert.match(withPath.stderr, /no path/);
});
