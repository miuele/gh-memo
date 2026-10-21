// Loads the app's modules into a fresh Node `vm` sandbox, the same way the
// browser does: src/define.js first, then every module file. Nothing runs
// until a module is required, so loading everything is cheap and side-effect free.
//
//   const require = load({ fakes: { 'storage/notesDb': fakeDb } });
//   const Sync = require('actions/sync');
//
// `fakes` replace real modules by name. `globals` adds sandbox globals
// (e.g. a fake localStorage). Values created inside the sandbox come from a
// different realm, so compare them with `same()` rather than deepStrictEqual.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
	e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []);

export const moduleFiles = () => [
	...walk(path.join(ROOT, 'src')).filter(f => !f.endsWith(path.join('src', 'define.js'))).sort(),
	path.join(ROOT, 'build', 'resources.js'),
	path.join(ROOT, 'build', 'buildInfo.js'),
];

export const relative = (file) => path.relative(ROOT, file);

export function load({ fakes = {}, globals = {} } = {}) {
	const ctx = vm.createContext({
		console, setTimeout, clearTimeout, btoa, atob, TextEncoder, TextDecoder,
		URL, URLSearchParams, Blob, Response, AbortController,
		...globals,
	});
	const run = (file) => vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: relative(file) });

	// Evaluate the loader in its own scope so the global `define` seen by the
	// module files can be the wrapper below.
	const loaderSource = fs.readFileSync(path.join(ROOT, 'src', 'define.js'), 'utf8');
	const realDefine = vm.runInContext(`(() => {\n${loaderSource}\nreturn define;\n})()`, ctx, { filename: 'src/define.js' });

	// Fakes win: the real module of the same name is skipped.
	ctx.define = Object.assign((name, deps, fn) => { if (!(name in fakes)) realDefine(name, deps, fn); }, realDefine);
	for (const [name, impl] of Object.entries(fakes)) realDefine(name, [], () => impl);

	moduleFiles().forEach(run);
	return realDefine.require;
}

// Cross-realm deep equality.
export const same = (actual, expected, message) =>
	assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
