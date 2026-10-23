// Readouts for the "report" section of a status file: { label: entry }.
// A plain string, number or boolean is shown as is (multi-line strings as a
// preformatted block); an object with a known `type` gets a widget. Status
// files come from another program, so everything is rendered as text,
// never as HTML.
define('plugins/panel/report', ['lib/dom', 'plugins/panel/model'], (Dom, Model) => {
	const { h } = Dom;

	// "40 s ago", "5 min ago", "3 h ago", "2 days ago".
	const ago = (seconds) => {
		if (seconds < 60) return `${Math.round(seconds)} s ago`;
		if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
		if (seconds < 86400 * 2) return `${Math.round(seconds / 3600)} h ago`;
		return `${Math.round(seconds / 86400)} days ago`;
	};

	// Local time, with the date unless it is today.
	const when = (iso, now = new Date()) => {
		const t = new Date(iso);
		if (Number.isNaN(t.getTime())) return String(iso ?? '');
		const time = t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
		return t.toDateString() === now.toDateString() ? time : `${t.toLocaleDateString()} ${time}`;
	};

	const text = (value) => (typeof value === 'string' && value.includes('\n')
		? h('pre', { class: 'panel-pre' }, value)
		: h('span', {}, typeof value === 'string' ? value : JSON.stringify(value)));

	const widgets = {
		// { "type": "meter", "value": 82, "min": 0, "max": 100, "unit": "%", "warn": 80 }
		meter(entry) {
			const min = typeof entry.min === 'number' ? entry.min : 0;
			const max = typeof entry.max === 'number' ? entry.max : 100;
			const meter = h('meter', { min: String(min), max: String(max), value: String(Number(entry.value) || 0) });
			if (typeof entry.warn === 'number') { meter.high = entry.warn; meter.optimum = min; }
			return h('span', { class: 'panel-inline' }, meter, h('span', {}, `${entry.value}${entry.unit ? ` ${entry.unit}` : ''}`));
		},
		// { "type": "time", "value": "2026-10-22T08:10:07Z" }
		time(entry, now) {
			const t = Date.parse(entry.value);
			if (Number.isNaN(t)) return text(entry.value);
			return h('span', { title: new Date(t).toString() }, `${when(entry.value, now)} (${ago(Math.max(0, (now - t) / 1000))})`);
		},
		// { "type": "list", "items": ["a", "b"] }
		list: (entry) => h('ul', { class: 'panel-list' }, ...(Array.isArray(entry.items) ? entry.items : []).map(i => h('li', {}, typeof i === 'string' ? i : JSON.stringify(i)))),
		// { "type": "text", "value": "..." }: always preformatted
		text: (entry) => h('pre', { class: 'panel-pre' }, String(entry.value ?? '')),
	};

	const render = (entry, now = new Date()) => {
		if (Model.isObject(entry) && widgets[entry.type]) return widgets[entry.type](entry, now);
		if (entry !== null && typeof entry === 'object') return h('pre', { class: 'panel-pre' }, JSON.stringify(entry, null, 2));
		return text(entry);
	};

	// The whole report as label/value rows.
	const section = (report, now = new Date()) => h('div', { class: 'panel-report' },
		...Object.entries(Model.isObject(report) ? report : {}).map(([label, entry]) =>
			h('div', { class: 'panel-row' }, h('div', { class: 'panel-label' }, label), h('div', { class: 'panel-field' }, render(entry, now)))));

	return { ago, when, render, section, widgets };
});
