import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { load, moduleFiles, relative } from './harness.mjs';

test('each file defines exactly one module named after its path', () => {
	for (const file of moduleFiles()) {
		const names = [...fs.readFileSync(file, 'utf8').matchAll(/^define\('([^']+)'/gm)].map(m => m[1]);
		const expected = relative(file).replace(/^(src|build)\//, '').replace(/\.js$/, '');
		assert.deepEqual(names, [expected], relative(file));
	}
});

test('every module resolves: no cycles, no missing deps, no definition-time side effects', () => {
	const require = load();
	const names = moduleFiles().map(f => relative(f).replace(/^(src|build)\//, '').replace(/\.js$/, ''));
	for (const name of names) assert.ok(require(name), name);
	assert.ok(require('app/boot').start, 'app/boot exposes start()');
});

test('every data-action in index.m4 is handled by app/boot', () => {
	const html = fs.readFileSync(new URL('../index.m4', import.meta.url), 'utf8');
	const used = [...html.matchAll(/data-action="([^"]+)"/g)].map(m => m[1]);
	const { actions } = load()('app/boot');
	assert.ok(used.length > 0);
	for (const name of used) assert.equal(typeof actions[name], 'function', name);
});

test('layering: modules only depend on the same or lower layers', () => {
	const rank = { lib: 0, resources: 0, buildInfo: 0, model: 1, storage: 2, remote: 2, plugins: 3, ui: 3, actions: 4, app: 5 };
	const layerOf = (name) => rank[name.split('/')[0]];
	for (const file of moduleFiles()) {
		const src = fs.readFileSync(file, 'utf8');
		const m = src.match(/^define\('([^']+)',\s*\[([^\]]*)\]/m);
		const deps = [...m[2].matchAll(/'([^']+)'/g)].map(d => d[1]);
		for (const dep of deps) {
			assert.ok(layerOf(dep) <= layerOf(m[1]), `${m[1]} must not depend on ${dep}`);
		}
	}
});
