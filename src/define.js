// A minimal module registry. Every source file registers itself with
//
//     define('dir/name', ['dep/one', 'dep/two'], (One, Two) => { ...; return api; });
//
// Factories run lazily, the first time a module is required, with their
// dependencies passed in as arguments, so files can be concatenated in any
// order. Cycles and duplicate names fail loudly at load time.
//
// Factories must only build their object: no DOM or localStorage access at
// definition time. That keeps every module loadable under Node for tests.
const define = (() => {
	const factories = {};
	const cache = {};
	const loading = [];

	const require = (name) => {
		if (name in cache) return cache[name];
		const factory = factories[name];
		if (!factory) throw new Error(`Unknown module: ${name}`);
		if (loading.includes(name)) throw new Error(`Dependency cycle: ${[...loading, name].join(' -> ')}`);

		loading.push(name);
		try {
			return (cache[name] = factory.fn(...factory.deps.map(require)));
		} finally {
			loading.pop();
		}
	};

	const define = (name, deps, fn) => {
		if (factories[name]) throw new Error(`Duplicate module: ${name}`);
		factories[name] = { deps, fn };
	};

	define.require = require;
	define.names = () => Object.keys(factories);
	return define;
})();
