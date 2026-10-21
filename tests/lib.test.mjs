import test from 'node:test';
import assert from 'node:assert/strict';
import { load, same } from './harness.mjs';

const require = load();

test('lib/path', () => {
	const { cleanPath, resolvePath, parsePath } = require('lib/path');
	assert.equal(cleanPath('//a/b/'), 'a/b');
	assert.equal(cleanPath(undefined), '');
	assert.equal(resolvePath('docs/a/page.md', '../img/x.png'), 'docs/img/x.png');
	assert.equal(resolvePath('docs/page.md', './x.md'), 'docs/x.md');
	assert.equal(resolvePath('page.md', 'https://example.com/x'), 'https://example.com/x');
	same(parsePath('a/b/c.tar.gz'), { dir: 'a/b/', filename: 'c.tar.gz', basename: 'c.tar' });
	same(parsePath('README'), { dir: '', filename: 'README', basename: 'README' });
});

test('lib/fileTypes', () => {
	const T = require('lib/fileTypes');
	assert.ok(T.isTextFile('Makefile') && T.isTextFile('a.md') && T.isTextFile('x.symlink'));
	assert.ok(!T.isTextFile('a.png') && T.isBinaryFile('a.zip') && T.isBinaryFile('a.pdf'));
	assert.ok(T.isMarkdownFile('A.MARKDOWN') && !T.isMarkdownFile('a.txt'));
	assert.equal(T.mimeTypeFor('a.jpg'), 'image/jpeg');
	assert.equal(T.mimeTypeFor('a.svg'), 'image/svg+xml');
	assert.equal(T.mimeTypeFor('a.png'), 'image/png');
	assert.equal(T.mimeTypeFor('a.pdf'), 'application/pdf');
	assert.equal(T.mimeTypeFor('a.zip'), 'application/octet-stream');
});

test('lib/encoding round-trips UTF-8 and blobs', async () => {
	const E = require('lib/encoding');
	const text = 'héllo ∑ 日本 🎉';
	assert.equal(E.atou(E.utoa(text)), text);
	assert.equal(E.atou(E.utoa(text).replace(/(.{4})/g, '$1\n')), text, 'tolerates GitHub line breaks');
	assert.equal(await E.blobToBase64(new Blob([new Uint8Array([0, 255, 128])])), 'AP+A');
});

test('lib/pkce produces an RFC 7636 verifier and challenge', async () => {
	const P = load({ globals: { crypto: globalThis.crypto } })('lib/pkce');
	const v = P.generateCodeVerifier();
	assert.match(v, /^[0-9a-f]{56}$/);
	assert.match(await P.generateCodeChallenge(v), /^[A-Za-z0-9_-]{43}$/);
});
