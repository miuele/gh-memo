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

test('symlinks match workspaces on the fields they name', () => {
	const S = load()('model/symlink');
	const { workspaces } = fakeConfig('root');
	same(S.findTargets(S.parse('{"rootDir": "docs"}'), workspaces), ['docs']);
	same(S.findTargets(S.parse('{"owner": "o", "repo": "r"}'), workspaces), ['root', 'docs', 'api']);
	same(S.matchableKeys(S.parse('{"nope": 1}')), []);
	assert.throws(() => S.parse('{bad'));
});
