// Control panels: a visual editor and viewer for JSON files shared with
// other programs. Syncing is the app's usual Pull and Push.
//
//  * *.panel.json lists controls and holds their values. View mode shows the
//    controls as a form, and command buttons append to the file's queue;
//    edit mode is the raw JSON. Every change goes through the normal
//    autosave. It also reads the status file of the same name
//    (x.panel.json -> x.status.json) through the plugin host, and the form
//    shows what that file reports beside each control.
//  * *.status.json, written by the program, shows as a read-only dashboard.
//
// The formats are in src/plugins/panel/README.md.
define('plugins/panel',
	['lib/dom', 'plugins/textEditor', 'plugins/panel/model', 'plugins/panel/controls', 'plugins/panel/report'],
	(Dom, TextEditor, Model, Controls, Report) => {
	const { h } = Dom;

	const PANEL_SUFFIX = /\.panel\.json$/i;
	const isStatusFile = (fn) => /\.status\.json$/i.test(fn || '');
	// x.panel.json -> x.status.json, relative to the panel (same folder).
	const statusRefOf = (fn) => (PANEL_SUFFIX.test(fn || '') ? fn.slice(fn.lastIndexOf('/') + 1).replace(PANEL_SUFFIX, '.status.json') : null);

	// How often the "updated … ago" texts are redrawn.
	const CLOCK_MS = 15000;

	const LIVENESS = { live: 'Online', late: 'Late', offline: 'Offline' };
	const COMMAND_LABEL = { waiting: 'waiting', 'no-result': 'no result' };
	const VALUE_BADGE = {
		ok: () => '✓ Applied',
		pending: () => '⏳ Not picked up yet',
		error: (vs) => `⚠️ ${vs.message}`,
		differs: (vs, spec) => `Reported: ${Model.describe(spec, vs.reported)}`,
		unhandled: () => 'Not handled by the program',
	};
	const HISTORY_LENGTH = 3;
	const MAX_OUTPUT = 2000;

	const seconds = (s) => (s < 120 ? `${s} s` : s < 7200 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`);
	const section = (title, rows) => (rows.length ? [h('h3', { class: 'panel-heading' }, title), ...rows] : []);
	const output = (text) => h('pre', { class: 'panel-pre' }, text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}…` : text);

	return {
		canHandle: (fn) => PANEL_SUFFIX.test(fn || '') || isStatusFile(fn),
		statusRefOf,
		create: () => ({
			name: 'PanelPlugin',
			supportedModes: ['edit', 'view'],
			// Opens as a form whatever mode the previous file was in.
			preferredMode: 'view',
			textarea: null,
			viewLayer: null,
			filename: null,
			onEdit: null,
			doc: null,
			fields: [],
			frozen: false,
			host: null,
			unsubscribe: null,
			clock: null,
			// A panel's status file: { ref, doc, problem }, from the stored copy.
			status: null,
			// Elements updated in place by updateLive(), so a status change never
			// rebuilds the inputs the user may be typing in.
			live: null,

			mount: async function(filename, content, viewLayer, editLayer, onEdit, { isViewMode, host } = {}) {
				this.filename = filename;
				this.viewLayer = viewLayer;
				this.onEdit = onEdit;
				this.host = host || null;
				this.textarea = TextEditor.create(content, onEdit);
				editLayer.appendChild(this.textarea);

				const ref = statusRefOf(filename);
				if (ref && this.host) {
					this.status = { ref, doc: null, problem: null };
					this.unsubscribe = this.host.onChange(() => this.loadStatus());
					this.clock = setInterval(() => this.updateLive(), CLOCK_MS);
					await this.loadStatus();
				}
				if (isViewMode) this.render();
			},

			onModeSwitch: async function(isViewMode) {
				if (isViewMode) this.render();
				else this.textarea.focus();
			},

			// Rebuilds the view from the text, which is the source of truth.
			render: function() {
				const { doc, error } = Model.parse(this.textarea.value);
				this.doc = doc || null;
				this.fields = [];
				this.live = null;
				if (error) {
					this.viewLayer.replaceChildren(h('div', { class: 'panel' },
						h('div', { class: 'panel-error' }, error),
						h('p', { class: 'panel-note' }, 'Switch to ✏️ to fix the file.')));
					return;
				}
				if (isStatusFile(this.filename)) return this.renderStatus();

				this.live = { strip: h('div', { class: 'panel-strip' }), badges: [], histories: [], report: h('div') };
				const controls = Model.controlsOf(doc);
				const body = controls.length
					? controls.map(spec => this.renderControl(spec))
					: [h('p', { class: 'panel-note' }, 'This panel has no controls yet. Switch to ✏️ and add a "controls" list.')];

				this.viewLayer.replaceChildren(h('div', { class: 'panel' },
					h('h2', { class: 'panel-title' }, String(doc.title ?? this.filename)),
					this.live.strip,
					...body,
					this.live.report));
				this.updateLive();
				if (this.frozen) this.fields.forEach(f => f.setDisabled(true));
			},

			/* =================================================================
			   A PANEL FILE: the form
			================================================================= */

			renderControl: function(spec) {
				const type = Controls.get(spec.type);
				if (type.layout) return type.render(spec).el;
				if (typeof spec.id !== 'string' || !spec.id) return h('div', { class: 'panel-msg' }, `A "${spec.type}" control has no "id".`);

				if (type.command) {
					const field = type.render(spec, undefined, { run: (args) => this.runCommand(spec, args) });
					this.fields.push(field);
					const history = h('div', { class: 'panel-history' });
					this.live.histories.push({ spec, el: history });
					return h('div', { class: 'panel-row panel-command' }, field.el, history);
				}

				const msg = h('div', { class: 'panel-msg' });
				const setMessage = (text) => { msg.textContent = text || ''; };
				const commit = (value) => {
					const error = Model.validate(spec, value);
					setMessage(error);
					if (!error) this.applyDoc(Model.bumpRev(Model.withValue(this.doc, spec.id, value)));
				};

				const field = type.render(spec, Model.valueOf(this.doc, spec), { commit, fail: setMessage });
				this.fields.push(field);
				const id = `panel-${spec.id}`;
				if (field.input) field.input.id = id;
				const badge = h('div', { class: 'panel-badge' });
				this.live.badges.push({ spec, el: badge });

				return h('div', { class: 'panel-row' },
					h('label', { class: 'panel-label', for: id }, String(spec.label ?? spec.id)),
					h('div', { class: 'panel-field' }, field.el, badge, msg));
			},

			// Writes `doc` into the editor buffer and the autosave.
			applyDoc: function(doc) {
				this.doc = doc;
				const text = Model.serialize(doc, Model.detectIndent(this.textarea.value));
				this.textarea.value = text;
				this.onEdit(text);
				this.updateLive();
			},

			runCommand: function(spec, args) {
				const command = typeof spec.command === 'string' ? spec.command : spec.id;
				if (spec.confirm && !confirm(typeof spec.confirm === 'string' ? spec.confirm : `${spec.label ?? command}?`)) return;
				const now = new Date();
				this.applyDoc(Model.addCommand(this.doc, command, args, now, Model.newCommandId(now)));
			},

			/* =================================================================
			   A PANEL FILE: what its status file reports, beside the controls
			================================================================= */

			// Reads the stored status file again (a pull or another tab stored a newer one).
			loadStatus: async function() {
				const status = this.status;
				if (!status) return;
				let file = null;
				let problem = null;
				try {
					file = await this.host.read(status.ref);
				} catch (err) {
					problem = err.message;
				}
				if (this.status !== status) return;
				const { doc, error } = file ? Model.parse(typeof file.content === 'string' ? file.content : '') : {};
				status.doc = doc || null;
				status.problem = problem || (error ? `${status.ref}: ${error}` : null);
				this.updateLive();
			},

			updateLive: function() {
				if (!this.live || !this.doc) return;
				const now = new Date();
				const st = this.status && this.status.doc;
				this.live.strip.replaceChildren(...this.statusLine(now));

				for (const { spec, el } of this.live.badges) {
					const vs = Model.valueState(this.doc, st, spec);
					el.className = `panel-badge panel-badge-${vs.state}`;
					el.textContent = VALUE_BADGE[vs.state] ? VALUE_BADGE[vs.state](vs, spec) : '';
				}

				// Under each command button: its latest queue entries, with their results.
				for (const { spec, el } of this.live.histories) {
					const command = typeof spec.command === 'string' ? spec.command : spec.id;
					const notes = st && !Model.commandHandled(st, command)
						? [h('div', { class: 'panel-badge panel-badge-unhandled' }, 'Not handled by the program')] : [];
					el.replaceChildren(...notes, ...Model.historyOf(this.doc, command).slice(0, HISTORY_LENGTH).map(e => this.historyRow(e, st, now)));
				}

				const report = st && st.report;
				this.live.report.replaceChildren(...(Model.isObject(report) && Object.keys(report).length
					? section('Report', [Report.section(report, now)]) : []));
			},

			// "Online · updated 40 s ago · panel rev 4 · home.status.json", as of the stored copy.
			statusLine: function(now) {
				const status = this.status;
				if (!status) return [];
				if (status.problem) return [h('div', { class: 'panel-strip-line' }, h('span', { class: 'panel-msg' }, `⚠️ ${status.problem}`))];
				if (!status.doc) {
					return [h('div', { class: 'panel-strip-line' }, h('span', { class: 'panel-dot' }),
						h('span', { class: 'panel-muted' }, `No ${status.ref} on this device yet. Open and pull it once the program has written one.`))];
				}
				const line = this.livenessLine(status.doc, now);
				line.appendChild(h('span', { class: 'panel-muted' }, `· ${status.ref}`));
				return [line];
			},

			historyRow: function(entry, st, now) {
				const { state, result } = st ? Model.commandState(entry, st) : { state: 'queued' };
				const args = Model.isObject(entry.args) ? Object.values(entry.args).map(v => (typeof v === 'string' ? v : JSON.stringify(v))).join(', ') : '';
				const out = result && result.output != null && result.output !== '' ? String(result.output) : '';
				return h('div', { class: 'panel-history-row' },
					h('span', { class: `panel-chip panel-chip-${state}` }, COMMAND_LABEL[state] || state),
					h('span', { class: 'panel-muted' }, Report.when(entry.at, now)),
					...(args ? [h('span', { class: 'panel-args' }, args)] : []),
					...(out ? [output(out)] : []));
			},

			/* =================================================================
			   A STATUS FILE: read-only dashboard
			================================================================= */

			renderStatus: function() {
				const now = new Date();
				const st = this.doc;
				const values = Model.isObject(st.values) ? st.values : {};
				const errors = Model.isObject(st.errors) ? st.errors : {};
				const results = Model.isObject(st.results) ? Object.entries(st.results).filter(([, r]) => Model.isObject(r)) : [];
				results.sort(([, a], [, b]) => String(b.at).localeCompare(String(a.at)));

				this.viewLayer.replaceChildren(h('div', { class: 'panel' },
					h('h2', { class: 'panel-title' }, String(st.title ?? this.filename)),
					h('div', { class: 'panel-strip' }, this.livenessLine(st, now)),
					...section('Values', [...new Set([...Object.keys(values), ...Object.keys(errors)])].map(k => h('div', { class: 'panel-row' },
						h('div', { class: 'panel-label' }, k),
						h('div', { class: 'panel-field' },
							Report.render(k in values ? values[k] : '(none)', now),
							...(errors[k] != null ? [h('div', { class: 'panel-badge panel-badge-error' }, `⚠️ ${errors[k]}`)] : []))))),
					...section('Commands', results.slice(0, 20).map(([id, r]) => h('div', { class: 'panel-history-row' },
						h('span', { class: `panel-chip panel-chip-${r.state}` }, String(r.state ?? '?')),
						h('span', { class: 'panel-muted' }, Report.when(r.at, now)),
						h('span', { class: 'panel-args' }, id),
						...(r.output ? [output(String(r.output))] : [])))),
					...(Model.isObject(st.report) ? section('Report', [Report.section(st.report, now)]) : [])));
			},

			// "Online · updated 40 s ago", from the file's own time and heartbeat,
			// as of the copy stored here (pull for a newer one).
			livenessLine: function(st, now) {
				const { state, age } = Model.liveness(st, now);
				let text;
				if (state === 'none') text = 'No "updated" time in this file';
				else if (state === 'unknown') text = `Updated ${Report.ago(age)}`;
				else {
					text = `${LIVENESS[state]} · updated ${Report.ago(age)}`;
					if (state !== 'live') text += ` (expected every ${seconds(st.heartbeat_seconds)})`;
				}
				if (typeof st.rev === 'number') text += ` · panel rev ${st.rev}`;
				return h('div', { class: 'panel-strip-line' }, h('span', { class: `panel-dot panel-dot-${state}` }), h('span', {}, text));
			},

			freeze: function() {
				this.frozen = true;
				if (this.textarea) this.textarea.disabled = true;
				this.fields.forEach(f => f.setDisabled(true));
			},

			unmount: function() {
				if (this.unsubscribe) this.unsubscribe();
				clearInterval(this.clock);
				this.unsubscribe = null;
				this.host = null;
				this.status = null;
				this.live = null;
				this.textarea = null;
				this.viewLayer = null;
				this.fields = [];
			},
		}),
	};
});
