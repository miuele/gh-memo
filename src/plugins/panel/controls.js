// Control types for the panel plugin, by `type`. Each one builds the input
// part of a control row:
//
//   render(spec, value, { commit, fail, run }) -> { el, input, setDisabled(bool) }
//
// `commit(value)` reports a new value (the panel validates and saves it);
// `fail(message)` reports input that can't become a value at all; `run(args)`
// queues a command (command types only). Inputs
// commit on 'change', not on every keystroke, so one edit is one change.
// Types with `layout: true` hold no value and get no label, badge or id.
// An unknown type falls back to editing the value as raw JSON.
define('plugins/panel/controls', ['lib/dom', 'plugins/panel/model'], (Dom, Model) => {
	const { h } = Dom;

	// Wraps one or more inputs so they can all be disabled together. The first
	// one gets the row label.
	const field = (el, inputs = [el]) => ({ el, input: inputs[0], setDisabled: (off) => inputs.forEach(i => { i.disabled = off; }) });

	const numberAttrs = (spec) => {
		const attrs = {};
		for (const k of ['min', 'max', 'step']) if (typeof spec[k] === 'number') attrs[k] = String(spec[k]);
		if (!attrs.step) attrs.step = spec.integer ? '1' : 'any';
		return attrs;
	};

	const withUnit = (spec, el) => (spec.unit ? h('span', { class: 'panel-inline' }, el, h('span', { class: 'panel-unit' }, spec.unit)) : el);

	const types = {
		heading: { layout: true, render: (spec) => field(h('h3', { class: 'panel-heading' }, String(spec.label ?? '')), []) },

		note: { layout: true, render: (spec) => field(h('p', { class: 'panel-note' }, String(spec.text ?? spec.label ?? '')), []) },

		number: {
			render(spec, value, { commit, fail }) {
				const input = h('input', { type: 'number', inputmode: 'decimal', ...numberAttrs(spec) });
				if (typeof value === 'number') input.value = String(value);
				input.addEventListener('change', () => {
					if (input.value === '') return fail('Enter a number.');
					commit(Number(input.value));
				});
				return field(withUnit(spec, input), [input]);
			},
		},

		slider: {
			render(spec, value, { commit }) {
				const input = h('input', { type: 'range', ...numberAttrs(spec) });
				const out = h('output', { class: 'panel-unit' });
				const show = () => { out.textContent = spec.unit ? `${input.value} ${spec.unit}` : input.value; };
				// A range input can't be empty, so an unset value says so in words.
				if (typeof value === 'number') {
					input.value = String(value);
					show();
				} else out.textContent = '(not set)';
				input.addEventListener('input', show);
				input.addEventListener('change', () => commit(Number(input.value)));
				return field(h('span', { class: 'panel-inline' }, input, out), [input]);
			},
		},

		toggle: {
			render(spec, value, { commit }) {
				const input = h('input', { type: 'checkbox', class: 'panel-switch', role: 'switch' });
				input.checked = value === true;
				input.addEventListener('change', () => commit(input.checked));
				return field(input);
			},
		},

		select: {
			render(spec, value, { commit }) {
				const options = Model.optionsOf(spec);
				const select = h('select', {});
				const current = options.findIndex(o => Model.same(o.value, value));
				// A value that isn't one of the options is shown, not silently replaced.
				if (current === -1) {
					select.appendChild(h('option', { value: '', disabled: '' }, value === undefined ? '— choose —' : `${Model.describe({}, value)} (not an option)`));
				}
				options.forEach((o, i) => select.appendChild(h('option', { value: String(i) }, o.label)));
				select.value = current === -1 ? '' : String(current);
				select.addEventListener('change', () => commit(options[Number(select.value)].value));
				return field(select);
			},
		},

		text: {
			render(spec, value, { commit }) {
				const input = h('input', { type: 'text', placeholder: String(spec.placeholder ?? '') });
				input.value = typeof value === 'string' ? value : '';
				input.addEventListener('change', () => commit(input.value));
				return field(input);
			},
		},

		textarea: {
			render(spec, value, { commit }) {
				const input = h('textarea', { rows: String(spec.rows || 4), placeholder: String(spec.placeholder ?? '') });
				input.value = typeof value === 'string' ? value : '';
				input.addEventListener('change', () => commit(input.value));
				return field(input);
			},
		},
	};

	// A command: optional `fields` (controls whose values become the
	// command's arguments, not stored in `values`) and a button. Pressing it
	// calls `run(args)` once every field is valid; `run` asks for confirmation.
	types.button = {
		command: true,
		render(spec, _value, { run }) {
			const fieldSpecs = (Array.isArray(spec.fields) ? spec.fields : []).filter(f => Model.isObject(f) && typeof f.id === 'string');
			const args = {};
			const inputs = [];
			const rows = fieldSpecs.map(f => {
				const msg = h('div', { class: 'panel-msg' });
				const setMessage = (text) => { msg.textContent = text || ''; };
				if (f.default !== undefined) args[f.id] = f.default;
				const sub = (types[f.type] || raw).render(f, f.default, {
					commit: (v) => { args[f.id] = v; setMessage(Model.validate(f, v)); },
					fail: (text) => { delete args[f.id]; setMessage(text); },
				});
				inputs.push(...(sub.input ? [sub.input] : []));
				return { f, setMessage, el: h('label', { class: 'panel-arg' }, h('span', {}, String(f.label ?? f.id)), sub.el, msg) };
			});

			const button = h('button', { type: 'button', class: 'panel-run' }, String(spec.label ?? spec.id));
			button.addEventListener('click', () => {
				let ok = true;
				for (const { f, setMessage } of rows) {
					const v = args[f.id];
					const error = v === undefined ? (f.required ? 'Required.' : null) : Model.validate(f, v);
					setMessage(error);
					if (error) ok = false;
				}
				if (ok) run({ ...args });
			});
			inputs.push(button);
			return field(h('div', { class: 'panel-command-form' }, ...rows.map(r => r.el), button), inputs);
		},
	};

	// Unknown types: edit the value as JSON, so nothing in the file is out of reach.
	const raw = {
		render(spec, value, { commit, fail }) {
			const input = h('input', { type: 'text', class: 'panel-raw', title: `Unknown control type "${spec.type}": edit the value as JSON` });
			input.value = value === undefined ? '' : JSON.stringify(value);
			input.addEventListener('change', () => {
				try {
					commit(JSON.parse(input.value));
				} catch (err) {
					fail('Not valid JSON.');
				}
			});
			return field(input);
		},
	};

	return {
		types,
		get: (type) => types[type] || raw,
	};
});
