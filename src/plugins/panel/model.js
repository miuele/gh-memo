// The panel and status file formats, as pure functions over parsed JSON
// (no DOM, no I/O, no clock: callers pass `now`).
// The format is described in src/plugins/panel/README.md.
define('plugins/panel/model', [], () => {
	const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
	const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

	// Keeps the file's own indentation (tabs, or the width of the first
	// indented line) when it is written back. Two spaces otherwise.
	const detectIndent = (text) => {
		const m = /\n([ \t]+)\S/.exec(text || '');
		if (!m) return 2;
		return m[1][0] === '\t' ? '\t' : m[1].length;
	};

	// { doc } or { error }. A panel file must be a JSON object.
	const parse = (text) => {
		let doc;
		try {
			doc = JSON.parse(text || '{}');
		} catch (err) {
			return { error: `Invalid JSON: ${err.message}` };
		}
		if (!isObject(doc)) return { error: 'A panel file must contain a JSON object.' };
		return { doc };
	};

	const serialize = (doc, indent = 2) => JSON.stringify(doc, null, indent) + '\n';

	const controlsOf = (doc) => (Array.isArray(doc.controls) ? doc.controls.filter(isObject) : []);
	const valuesOf = (doc) => (isObject(doc.values) ? doc.values : {});

	// The value a control shows: the stored one, else its default.
	const valueOf = (doc, spec) => {
		const values = valuesOf(doc);
		return spec.id in values ? values[spec.id] : spec.default;
	};

	// Select options may be plain values or { value, label }.
	const optionsOf = (spec) => (Array.isArray(spec.options) ? spec.options : [])
		.map(o => (isObject(o) ? { value: o.value, label: o.label ?? String(o.value) } : { value: o, label: String(o) }));

	// How a value reads to a person: the option label for selects, plus the unit.
	const describe = (spec, value) => {
		if (value === undefined) return '(none)';
		if (spec.type === 'select') {
			const opt = optionsOf(spec).find(o => same(o.value, value));
			if (opt) return opt.label;
		}
		if (spec.type === 'toggle' && typeof value === 'boolean') return value ? 'on' : 'off';
		const text = typeof value === 'string' ? value : JSON.stringify(value);
		return spec.unit ? `${text} ${spec.unit}` : text;
	};

	// Returns an error message, or null when `value` is acceptable for `spec`.
	const validate = (spec, value) => {
		switch (spec.type) {
			case 'number':
			case 'slider': {
				if (typeof value !== 'number' || !Number.isFinite(value)) return 'Enter a number.';
				if (typeof spec.min === 'number' && value < spec.min) return `Must be at least ${spec.min}.`;
				if (typeof spec.max === 'number' && value > spec.max) return `Must be at most ${spec.max}.`;
				if (spec.integer && !Number.isInteger(value)) return 'Must be a whole number.';
				return null;
			}
			case 'toggle':
				return typeof value === 'boolean' ? null : 'Must be on or off.';
			case 'select':
				return optionsOf(spec).some(o => same(o.value, value)) ? null : 'Not one of the options.';
			case 'text':
			case 'textarea': {
				if (typeof value !== 'string') return 'Must be text.';
				if (spec.required && !value.trim()) return 'Required.';
				if (typeof spec.maxLength === 'number' && value.length > spec.maxLength) return `At most ${spec.maxLength} characters.`;
				if (spec.pattern && value) {
					let re;
					try { re = new RegExp(`^(?:${spec.pattern})$`); } catch (err) { return `The panel's pattern is invalid: ${err.message}`; }
					if (!re.test(value)) return spec.patternHint || 'Not in the expected format.';
				}
				return null;
			}
			default:
				return null;
		}
	};

	// A copy of `doc` with values[id] = value. Leaves the rest of the file,
	// including keys this module doesn't know, untouched.
	const withValue = (doc, id, value) => ({ ...doc, values: { ...valuesOf(doc), [id]: value } });

	/* =====================================================================
	   COMMANDS (in the panel file) AND STATUS FILES (written by a program)
	===================================================================== */

	const revOf = (doc) => (Number.isInteger(doc && doc.rev) ? doc.rev : 0);
	const queueOf = (doc) => (Array.isArray(doc.queue) ? doc.queue.filter(e => isObject(e) && typeof e.id === 'string') : []);
	const keepDays = (doc) => (typeof doc.keep_days === 'number' && doc.keep_days > 0 ? doc.keep_days : 7);
	const MAX_QUEUE = 50;

	// Every change to values or the queue bumps `rev`, so a program reading the
	// file can tell whether anything changed since it last looked.
	const bumpRev = (doc) => ({ ...doc, rev: revOf(doc) + 1 });

	// c-20261022T072227-a0mqo8: sortable by time, unique enough across devices.
	const newCommandId = (now, random = Math.random) => {
		const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
		const tail = Array.from({ length: 6 }, () => '0123456789abcdefghijklmnopqrstuvwxyz'[Math.floor(random() * 36)]).join('');
		return `c-${stamp}-${tail}`;
	};

	// Drops queue entries older than keep_days, and all but the newest MAX_QUEUE.
	const prune = (doc, now) => {
		if (!Array.isArray(doc.queue)) return doc;
		const cutoff = now.getTime() - keepDays(doc) * 86400e3;
		const kept = queueOf(doc).filter(e => !(Date.parse(e.at) < cutoff));
		return { ...doc, queue: kept.slice(-MAX_QUEUE) };
	};

	const addCommand = (doc, command, args, now, id) => {
		const next = bumpRev(doc);
		const entry = { id, command, args, at: now.toISOString(), rev: next.rev };
		return prune({ ...next, queue: [...queueOf(doc), entry] }, now);
	};

	// How recently the program wrote its status, against how often it says it does.
	// state: 'live' | 'late' | 'offline' | 'unknown' (no heartbeat given) | 'none' (no time at all)
	const liveness = (status, now) => {
		const updated = status ? Date.parse(status.updated) : NaN;
		if (Number.isNaN(updated)) return { state: 'none', age: null };
		const age = Math.max(0, (now.getTime() - updated) / 1000);
		const beat = status.heartbeat_seconds;
		if (typeof beat !== 'number' || beat <= 0) return { state: 'unknown', age };
		if (age <= 2 * beat + 60) return { state: 'live', age };
		if (age <= 10 * beat + 60) return { state: 'late', age };
		return { state: 'offline', age };
	};

	const acceptsList = (status, kind) => {
		const a = status && isObject(status.accepts) ? status.accepts[kind] : undefined;
		return Array.isArray(a) ? a : null;
	};

	// A setting as the program reports it in the status file, against the panel.
	// state: 'ok' | 'pending' (the program hasn't seen this rev yet) | 'error'
	//      | 'differs' | 'unhandled' | 'unknown' (not reported)
	const valueState = (doc, status, spec) => {
		if (!isObject(status)) return { state: 'unknown' };
		const accepted = acceptsList(status, 'values');
		if (accepted && !accepted.includes(spec.id)) return { state: 'unhandled' };

		const reported = isObject(status.values) && spec.id in status.values ? status.values[spec.id] : undefined;
		const wanted = valueOf(doc, spec);
		const seen = typeof status.rev === 'number' ? status.rev >= revOf(doc) : null;
		const error = isObject(status.errors) && status.errors[spec.id] != null ? String(status.errors[spec.id]) : null;

		if (wanted !== undefined && reported !== undefined && same(wanted, reported)) return { state: 'ok', reported };
		if (seen === false) return { state: 'pending', reported };
		if (error) return { state: 'error', reported, message: error };
		if (reported === undefined) return { state: 'unknown' };
		return { state: 'differs', reported };
	};

	// A queued command's state: the program's own result state ('running',
	// 'done', 'failed', 'rejected', or anything else it writes), else
	// 'no-result' once it has seen the entry's rev, else 'waiting'.
	const commandState = (entry, status) => {
		const result = isObject(status) && isObject(status.results) ? status.results[entry.id] : undefined;
		if (isObject(result) && typeof result.state === 'string') return { state: result.state, result };
		if (isObject(status) && typeof status.rev === 'number' && typeof entry.rev === 'number' && status.rev >= entry.rev) return { state: 'no-result' };
		return { state: 'waiting' };
	};

	const commandHandled = (status, command) => {
		const accepted = acceptsList(status, 'commands');
		return !accepted || accepted.includes(command);
	};

	// The queue entries for one command, newest first.
	const historyOf = (doc, command) => queueOf(doc).filter(e => e.command === command).reverse();

	return {
		isObject, same, detectIndent, parse, serialize, controlsOf, valuesOf, valueOf, optionsOf, describe, validate, withValue,
		revOf, queueOf, bumpRev, newCommandId, prune, addCommand, liveness, valueState, commandState, commandHandled, historyOf,
	};
});
