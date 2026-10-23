import test from 'node:test';
import assert from 'node:assert/strict';
import { load, same } from './harness.mjs';

// A fake lib/net that records requests and replies from a script.
const fakeNet = (replies) => {
	const calls = [];
	return {
		calls,
		fetchWithTimeout: async (url, options = {}) => {
			calls.push({ url, ...options });
			const r = replies.shift() || { status: 200, body: {} };
			return {
				ok: r.status < 400, status: r.status,
				json: async () => r.body, text: async () => r.text, blob: async () => new Blob([r.text || '']),
				headers: { get: (k) => (r.headers || {})[k] },
			};
		},
	};
};
const ws = { host: 'https://api.github.com', owner: 'o', repo: 'r', branch: 'main', rootDir: 'docs', shallow: false };
const kc = { token: 'tok' };

test('github: deep tree is rooted at the mount and keeps blobs only', async () => {
	const net = fakeNet([{ status: 200, body: { tree: [{ path: 'a.md', type: 'blob', sha: '1', size: 3 }, { path: 'sub', type: 'tree', sha: '2' }] } }]);
	const GitHub = load({ fakes: { 'lib/net': net } })('remote/github');
	same(await GitHub.getTree(ws, kc), { tree: [{ path: 'a.md', sha: '1', type: 'blob', size: 3 }], truncated: false });
	assert.equal(net.calls[0].url, 'https://api.github.com/repos/o/r/git/trees/main:docs?recursive=1');
	assert.equal(net.calls[0].headers.Authorization, 'token tok');
});

test('github: putFile sends sha, branch and default message; 409 becomes a pull hint', async () => {
	const net = fakeNet([{ status: 200, body: { content: { sha: 'new' } } }, { status: 409, body: {} }]);
	const GitHub = load({ fakes: { 'lib/net': net } })('remote/github');
	same(await GitHub.putFile('a.md', 'QQ==', 'old', null, ws, kc), { content: { sha: 'new' } });
	assert.equal(net.calls[0].url, 'https://api.github.com/repos/o/r/contents/docs/a.md');
	same(JSON.parse(net.calls[0].body), { message: 'Update a.md', content: 'QQ==', branch: 'main', sha: 'old' });
	await assert.rejects(GitHub.putFile('a.md', 'QQ==', 'old', null, ws, kc), /Please Pull first/);
});

test('dropbox: paths, pagination and root stripping', async () => {
	const net = fakeNet([
		{ status: 200, body: { entries: [{ '.tag': 'file', path_display: '/Notes/a.md', rev: 'r1', size: 1 }], has_more: true, cursor: 'c1' } },
		{ status: 200, body: { entries: [{ '.tag': 'folder', path_display: '/Notes/sub', id: 'id:1' }], has_more: false } },
	]);
	const Dropbox = load({ fakes: { 'lib/net': net, 'model/config': {} } })('remote/dropbox');
	assert.equal(Dropbox._getFullPath('', ''), '');
	assert.equal(Dropbox._getFullPath('/Notes/', 'x/y.md'), '/Notes/x/y.md');
	assert.equal(Dropbox._stripRoot('Notes', '/Notes/x/y.md'), 'x/y.md');
	assert.equal(Dropbox._toHeaderSafeJson({ path: '/é' }), '{"path":"/\\u00e9"}');

	const res = await Dropbox.getTree({ rootDir: 'Notes', shallow: false }, { token: 't' });
	same(res, { tree: [{ path: 'a.md', sha: 'r1', type: 'blob', size: 1 }] }, 'folders dropped in deep mode');
	assert.equal(net.calls[1].url, 'https://api.dropboxapi.com/2/files/list_folder/continue');
	same(JSON.parse(net.calls[1].body), { cursor: 'c1' });
});

test('dropbox: a 401 refreshes the token, persists it and retries', async () => {
	const net = fakeNet([{ status: 401 }, { status: 200, body: { access_token: 'fresh' } }, { status: 200, body: { entries: [], has_more: false } }]);
	let saved = 0;
	const Dropbox = load({ fakes: { 'lib/net': net, 'model/config': { saveKeychains: () => saved++ } } })('remote/dropbox');
	const keychain = { token: 'stale', refreshToken: 'rt', appKey: 'k' };
	await Dropbox.getTree({ rootDir: '', shallow: true }, keychain);
	assert.equal(keychain.token, 'fresh');
	assert.equal(saved, 1);
	assert.equal(net.calls[2].headers.Authorization, 'Bearer fresh');
});

test('github: paths and ref are URL-encoded per segment (C5)', async () => {
	const net = fakeNet([]);
	const GitHub = load({ fakes: { 'lib/net': net } })('remote/github');
	const odd = { ...ws, branch: 'feat/a#b', rootDir: 'my docs' };
	await GitHub.getFile('50% off?#1.md', odd, kc);
	await GitHub.putFile('a&b/c d.md', 'QQ==', null, null, odd, kc);
	await GitHub.deleteFile('x#y.md', 's', odd, kc);
	await GitHub.getTree(odd, kc).catch(() => {});   // the fake replies {}, so only the URL matters
	await GitHub.getTree({ ...odd, shallow: true }, kc).catch(() => {});
	same(net.calls.map(c => c.url), [
		'https://api.github.com/repos/o/r/contents/my%20docs/50%25%20off%3F%231.md?ref=feat%2Fa%23b',
		'https://api.github.com/repos/o/r/contents/my%20docs/a%26b/c%20d.md',
		'https://api.github.com/repos/o/r/contents/my%20docs/x%23y.md',
		'https://api.github.com/repos/o/r/git/trees/feat/a%23b:my%20docs?recursive=1',
		'https://api.github.com/repos/o/r/contents/my%20docs?ref=feat%2Fa%23b',
	]);
	same(JSON.parse(net.calls[1].body).branch, 'feat/a#b');
});

test('github: a truncated deep tree is reported (D6)', async () => {
	const net = fakeNet([{ status: 200, body: { tree: [], truncated: true } }]);
	const GitHub = load({ fakes: { 'lib/net': net } })('remote/github');
	assert.equal((await GitHub.getTree(ws, kc)).truncated, true);
});

// remoteStorage: folder listings as the draft defines them.
const rsWs = { host: 'https://rs.example/storage/', rootDir: 'notes', shallow: false };
const rsKc = { token: 'tok' };
const listing = (items, etag) => ({ status: 200, body: { '@context': 'http://remotestorage.io/spec/folder-description', items }, headers: { ETag: `"${etag}"` } });

test('remotestorage: deep refresh walks folders, then revalidates with If-None-Match', async () => {
	const net = fakeNet([
		listing({ 'a.md': { ETag: 'e1', 'Content-Length': 3 }, 'sub dir/': { ETag: 'f2' } }, 'f1'),
		listing({ 'b.png': { ETag: 'e2', 'Content-Length': 5 } }, 'f2'),
		{ status: 304 },
		listing({ 'a.md': { ETag: 'e9', 'Content-Length': 4 }, 'sub dir/': { ETag: 'f2' } }, 'f3'),
	]);
	const Rs = load({ fakes: { 'lib/net': net } })('remote/remotestorage');
	const expected = [{ path: 'a.md', sha: 'e1', type: 'blob', size: 3 }, { path: 'sub dir/b.png', sha: 'e2', type: 'blob', size: 5 }];
	same(await Rs.getTree(rsWs, rsKc), { tree: expected, truncated: false });
	same(net.calls.map(c => c.url), ['https://rs.example/storage/notes/', 'https://rs.example/storage/notes/sub%20dir/']);
	assert.equal(net.calls[0].headers.Authorization, 'Bearer tok');

	// Nothing changed: one request, answered 304.
	same(await Rs.getTree(rsWs, rsKc), { tree: expected, truncated: false });
	assert.equal(net.calls.length, 3);
	assert.equal(net.calls[2].headers['If-None-Match'], '"f1"');

	// The root changed but the subfolder's ETag did not: it is not listed again.
	same((await Rs.getTree(rsWs, rsKc)).tree.map(e => e.sha), ['e9', 'e2']);
	assert.equal(net.calls.length, 4);
});

test('remotestorage: shallow lists one folder, folders included', async () => {
	const net = fakeNet([listing({ 'a.md': { ETag: 'e1', 'Content-Length': 1 }, 'sub/': { ETag: 'f2' } }, 'f1')]);
	const Rs = load({ fakes: { 'lib/net': net } })('remote/remotestorage');
	same(await Rs.getTree({ ...rsWs, rootDir: '', shallow: true }, rsKc), { tree: [
		{ path: 'a.md', sha: 'e1', type: 'blob', size: 1 }, { path: 'sub', sha: 'f2', type: 'folder', size: 0 }], truncated: false });
	assert.equal(net.calls[0].url, 'https://rs.example/storage/');
});

test('remotestorage: writes are always conditional; 412 becomes a pull hint', async () => {
	const net = fakeNet([
		{ status: 200, headers: { ETag: '"new"' } },
		{ status: 201, headers: { ETag: '"made"' } },
		{ status: 412, body: {} },
		{ status: 204 }, { status: 404 },
	]);
	const Rs = load({ fakes: { 'lib/net': net } })('remote/remotestorage');
	same(await Rs.putFile('a#b.md', 'aGk=', 'old', 'ignored', rsWs, rsKc), { content: { sha: 'new' } });
	assert.equal(net.calls[0].url, 'https://rs.example/storage/notes/a%23b.md');
	assert.equal(net.calls[0].method, 'PUT');
	assert.equal(net.calls[0].headers['If-Match'], '"old"');
	assert.equal(net.calls[0].headers['Content-Type'], 'text/plain; charset=utf-8');
	same(Array.from(net.calls[0].body), [104, 105]);

	same(await Rs.putFile('c.md', 'aGk=', null, null, rsWs, rsKc), { content: { sha: 'made' } });
	assert.equal(net.calls[1].headers['If-None-Match'], '*');
	assert.equal(net.calls[1].headers['If-Match'], undefined);

	await assert.rejects(Rs.putFile('a.md', 'aGk=', 'old', null, rsWs, rsKc), /Please Pull first/);

	await Rs.deleteFile('a.md', 'e1', rsWs, rsKc);
	assert.equal(net.calls[3].method, 'DELETE');
	assert.equal(net.calls[3].headers['If-Match'], '"e1"');
	await Rs.deleteFile('gone.md', 'e1', rsWs, rsKc);   // 404 is success
});

test('remotestorage: getFile returns base64 text and the ETag; errors come from the status', async () => {
	const net = fakeNet([{ status: 200, text: 'héllo', headers: { ETag: '"e1"' } }, { status: 401, body: {} }]);
	const Rs = load({ fakes: { 'lib/net': net } })('remote/remotestorage');
	const Encoding = load()('lib/encoding');
	const res = await Rs.getFile('a.md', rsWs, rsKc);
	assert.equal(Encoding.atou(res.content), 'héllo');
	assert.equal(res.sha, 'e1');
	await assert.rejects(Rs.getFile('a.md', rsWs, rsKc), /rejected the token/);
	assert.throws(() => Rs._storageUrl({ host: '' }), /storage URL/);
});

test('remotestorage: the tree signature is the storage URL', () => {
	const Forest = load({ fakes: { 'model/config': {} } })('model/forest');
	assert.equal(Forest.computeTreeSig({ host: 'https://rs.example/storage/' }, { provider: 'remotestorage' }), 'remotestorage|https://rs.example/storage');
});

test('binaries: getFile returns the Blob with the id of exactly those bytes (C6)', async () => {
	const globals = { crypto: globalThis.crypto };
	const Encoding = load({ globals })('lib/encoding');
	assert.equal(await Encoding.gitBlobSha(new Blob([])), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391', "git's empty blob");
	assert.equal(await Encoding.gitBlobSha(new Blob(['hello\n'])), 'ce013625030ba8dba906f756967f9e9ca394464a', 'as `git hash-object`');
	assert.equal(await load()('lib/encoding').gitBlobSha(new Blob(['x'])), null, 'no crypto.subtle: no sha');

	const GitHub = load({ fakes: { 'lib/net': fakeNet([{ status: 200, text: 'hello\n' }]) }, globals })('remote/github');
	const gh = await GitHub.getFile('a.png', ws, kc);
	assert.equal(gh.sha, 'ce013625030ba8dba906f756967f9e9ca394464a');
	assert.equal(gh.content.type, 'image/png');
	assert.equal(await gh.content.text(), 'hello\n');

	const Dropbox = load({ fakes: { 'lib/net': fakeNet([{ status: 200, text: 'x', headers: { 'Dropbox-API-Result': '{"rev":"r9"}' } }]), 'model/config': {} } })('remote/dropbox');
	const dbx = await Dropbox.getFile('a.png', { rootDir: '' }, { token: 't' });
	assert.equal(dbx.sha, 'r9');
	assert.equal(dbx.content.type, 'image/png');

	const Rs = load({ fakes: { 'lib/net': fakeNet([{ status: 200, text: 'x', headers: { ETag: '"e7"' } }]) } })('remote/remotestorage');
	const rs = await Rs.getFile('a.png', rsWs, rsKc);
	assert.equal(rs.sha, 'e7');
	assert.equal(rs.content.type, 'image/png');
});

test('dropbox: delete is conditional on the rev, and 409s are told apart by error_summary (C7)', async () => {
	const net = fakeNet([
		{ status: 200, body: {} },
		{ status: 409, body: { error_summary: 'path_lookup/not_found/..' } },
		{ status: 409, body: { error_summary: 'path_write/conflict/file/..' } },
		{ status: 409, body: { error_summary: 'too_many_write_operations/' } },
		{ status: 409, body: { error_summary: 'path/conflict/file/..' } },
		{ status: 409, body: { error_summary: 'path/insufficient_space/..' } },
		{ status: 409, body: {} },
	]);
	const Dropbox = load({ fakes: { 'lib/net': net, 'model/config': {} } })('remote/dropbox');
	const w = { rootDir: 'Notes' }, k = { token: 't' };

	await Dropbox.deleteFile('a.md', 'r1', w, k);
	same(JSON.parse(net.calls[0].body), { path: '/Notes/a.md', parent_rev: 'r1' });
	await Dropbox.deleteFile('gone.md', 'r1', w, k);   // already gone: deleted
	await assert.rejects(Dropbox.deleteFile('a.md', 'r1', w, k), /Please Pull first/);
	await assert.rejects(Dropbox.deleteFile('a.md', 'r1', w, k), /^Error: Dropbox: too_many_write_operations$/);

	await assert.rejects(Dropbox.putFile('a.md', 'QQ==', 'r1', null, w, k), /Please Pull first/);
	await assert.rejects(Dropbox.putFile('a.md', 'QQ==', 'r1', null, w, k), /^Error: Dropbox: path\/insufficient_space$/);
	await assert.rejects(Dropbox.putFile('a.md', 'QQ==', 'r1', null, w, k), /^Error: Upload failed$/);
});

test('github: a text file over 1 MB (encoding "none") is refused, not pulled as empty (C1)', async () => {
	const net = fakeNet([{ status: 200, body: { content: '', encoding: 'none', sha: 'big', size: 2000000 } }, { status: 200, body: { content: 'QQ==', encoding: 'base64', sha: 's' } }]);
	const GitHub = load({ fakes: { 'lib/net': net } })('remote/github');
	await assert.rejects(GitHub.getFile('big.md', ws, kc), /over 1 MB/);
	same(await GitHub.getFile('a.md', ws, kc), { content: 'QQ==', encoding: 'base64', sha: 's' });
});
