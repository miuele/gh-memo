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
