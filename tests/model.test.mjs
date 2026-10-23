import test from 'node:test';
import assert from 'node:assert/strict';
import { load, same } from './harness.mjs';

// A forest: one GitHub tree with mounts at /, docs and docs/api, plus a Dropbox tree.
const fakeConfig = (activeWorkspaceId) => {
	const keychains = { gh: { provider: 'github' }, dbx: { provider: 'dropbox' } };
	const base = { keychainId: 'gh', host: 'h', owner: 'o', repo: 'r', branch: 'main' };
	const workspaces = {
		root: { ...base, rootDir: '' },
		docs: { ...base, rootDir: '/docs/' },
		api: { ...base, rootDir: 'docs/api' },
		box: { keychainId: 'dbx', rootDir: 'Notes' },
	};
	return {
		keychains, workspaces, activeWorkspaceId, treePins: { 'github|h|o|r|main': ['docs/a.md'] },
		get activeWorkspace() { return this.workspaces[this.activeWorkspaceId] || null; },
		get activeKeychain() { return this.activeWorkspace ? this.keychains[this.activeWorkspace.keychainId] : null; },
	};
};
const forestFor = (activeId) => load({ fakes: { 'model/config': fakeConfig(activeId) } })('model/forest');

test('trees group by origin, deepest mount first', () => {
	same(forestFor('root').workspaceTrees(), { 'github|h|o|r|main': ['api', 'docs', 'root'], 'dropbox|dbx': ['box'] });
	assert.equal(forestFor('box').activeTreeSignature(), 'dropbox|dbx');
	same(forestFor('docs').activePins(), ['docs/a.md']);
	same(forestFor('box').activePins(), []);
});

test('path mapping between workspace and forest', () => {
	const F = forestFor('docs');
	assert.equal(F.getAbsolutePath('docs', 'a.md'), 'docs/a.md');
	assert.equal(F.getAbsolutePath('root', '/a.md'), 'a.md');
	assert.equal(F.getRelativePath('docs', 'docs/x/y.md'), 'x/y.md');
	assert.equal(F.getRelativePath('docs', 'docs'), '');
	assert.equal(F.getRelativePath('docs', 'docsite/a.md'), null, 'a / boundary (E3)');
	assert.equal(F.getRelativePath('docs', 'top.md'), null);
	assert.equal(F.getRelativePath('root', 'top.md'), 'top.md');
	assert.equal(F.resolveBestFit('docs/api/v1.md'), 'api');
	assert.equal(F.resolveBestFit('docs/apis.md'), 'docs');
	assert.equal(F.resolveBestFit('top.md'), 'root');
	assert.equal(F.getExactMount('docs/api'), 'api');
	assert.equal(F.getExactMount('docs/x'), undefined);
});

test('virtual mounts and parent navigation', () => {
	same(forestFor('root').getVirtualMounts(), ['docs/api', 'docs']);
	same(forestFor('docs').getVirtualMounts(), ['api']);
	same(forestFor('api').getVirtualMounts(), []);
	assert.equal(forestFor('api').getParentWorkspace(), 'docs');
	assert.equal(forestFor('docs').getParentWorkspace(), 'root');
	assert.equal(forestFor('root').getParentWorkspace(), null);
});

test('symlinks: the target is the first non-empty line (E8)', () => {
	const S = load()('model/symlink');
	assert.equal(S.target('\n  github:o/r@main:docs  \nignored'), 'github:o/r@main:docs');
	assert.equal(S.target(''), '');
	assert.equal(S.target(null), '');
});

const targetConfig = () => {
	const keychains = { gh: { provider: 'github' }, dbx: { provider: 'dropbox' }, dbx2: { provider: 'dropbox' }, rs: { provider: 'remotestorage' } };
	const gh = { keychainId: 'gh', host: 'https://api.github.com', owner: 'Rust-Lang', repo: 'nomicon', branch: 'main' };
	const workspaces = {
		root: { ...gh, rootDir: '' },
		src: { ...gh, rootDir: 'src' },
		feat: { ...gh, branch: 'feature/x', rootDir: '' },
		ghe: { ...gh, host: 'https://ghe.example.com/api/v3/', rootDir: '' },
		box: { keychainId: 'dbx', rootDir: 'Notes' },
		box2: { keychainId: 'dbx2', rootDir: '' },
		rsShort: { keychainId: 'rs', host: 'https://h', rootDir: '' },
		rsLong: { keychainId: 'rs', host: 'https://h:8765/storage/', rootDir: '' },
	};
	return { keychains, workspaces, activeWorkspaceId: 'root', get activeWorkspace() { return this.workspaces[this.activeWorkspaceId]; } };
};

test('targets: origins and formatting per provider (D11)', () => {
	const T = load({ fakes: { 'model/config': targetConfig() } })('model/target');
	assert.equal(T.forWorkspace('src', 'intro.md'), 'github:Rust-Lang/nomicon@main:src/intro.md');
	assert.equal(T.forWorkspace('src'), 'github:Rust-Lang/nomicon@main:src');
	assert.equal(T.forWorkspace('feat', 'a.md'), 'github:Rust-Lang/nomicon@feature/x:a.md');
	assert.equal(T.forWorkspace('ghe'), 'github://ghe.example.com/api/v3/Rust-Lang/nomicon@main', 'a root is just the origin');
	assert.equal(T.forWorkspace('box', 'todo.md'), 'dropbox:Notes/todo.md');
	assert.equal(T.forWorkspace('rsLong', 'n/a.md'), 'rs:https://h:8765/storage:n/a.md');
	assert.equal(T.encode('github:o/r@main:my notes/50% #1?.md'), 'github:o/r@main:my%20notes/50%25%20%231%3F.md');
	assert.equal(T.decode(T.encode('rs:https://h:8765/storage:ä:b.md')), 'rs:https://h:8765/storage:ä:b.md');
});

test('targets: resolve to the deepest mount, by the longest origin (D11)', () => {
	const T = load({ fakes: { 'model/config': targetConfig() } })('model/target');
	same(T.resolve('github:Rust-Lang/nomicon@main:src/intro.md'), { workspaceId: 'src', filename: 'intro.md' });
	same(T.resolve('github:rust-lang/NOMICON@main:src'), { workspaceId: 'src', filename: '' }, 'owner/repo ignore case');
	same(T.resolve('github:Rust-Lang/nomicon@main:README.md'), { workspaceId: 'root', filename: 'README.md' });
	same(T.resolve('github:Rust-Lang/nomicon@main'), { workspaceId: 'root', filename: '' });
	same(T.resolve('github:Rust-Lang/nomicon@feature/x:a:b@c.md'), { workspaceId: 'feat', filename: 'a:b@c.md' }, 'branch with /, path with : and @');
	same(T.resolve('github://ghe.example.com/api/v3/Rust-Lang/nomicon@main:x.md'), { workspaceId: 'ghe', filename: 'x.md' });
	same(T.resolve('dropbox:Notes/todo.md'), { workspaceId: 'box', filename: 'todo.md' }, 'the first Dropbox tree');
	same(T.resolve('rs:https://h:8765/storage:a.md'), { workspaceId: 'rsLong', filename: 'a.md' });
	same(T.resolve('rs:https://h:a.md'), { workspaceId: 'rsShort', filename: 'a.md' });
	assert.match(T.resolve('github:Rust-Lang/nomicon@Main:a.md').error, /No workspace/, 'branch is exact');
	assert.match(T.resolve('github:Rust-Lang/nomicon@mainline:a.md').error, /No workspace/);
	assert.match(T.resolve('a.md').error, /No workspace/, 'no bare filenames');
	assert.match(T.resolve('../a.md').error, /only works in a symlink/);
});

test('targets: relative ones stay in the link\'s tree (E8)', () => {
	const T = load({ fakes: { 'model/config': targetConfig() } })('model/target');
	const from = { sig: 'github|https://api.github.com|Rust-Lang|nomicon|main', path: 'guide/go.symlink' };
	same(T.resolve('../src/intro.md', { from }), { workspaceId: 'src', filename: 'intro.md' });
	same(T.resolve('./b.md', { from }), { workspaceId: 'root', filename: 'guide/b.md' });
	same(T.resolve('/src', { from }), { workspaceId: 'src', filename: '' });
	same(T.resolve('/', { from }), { workspaceId: 'root', filename: '' });
	assert.match(T.resolve('../../x.md', { from }).error, /above the repository root/);
});
