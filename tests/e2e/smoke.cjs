// Optional end-to-end smoke test. Not part of `make test`: it needs Playwright.
//
//   make PLUGINS="image pdf markdown panel text" serve &   # or any static server on dist/
//   node tests/e2e/smoke.cjs http://localhost:8000/index.html
//
// GitHub, Dropbox and a remoteStorage server are mocked with page.route(), so no tokens or network
// access are needed. CDN libraries load from the real CDN unless CDN_DIR is
// set, in which case they are served from local copies (and SRI is bypassed,
// since local copies are not byte-identical to the CDN builds).
//
// The service-worker section temporarily rewrites the served dist/sw.js
// (DIST_DIR to point elsewhere) and restores it when done.
//
// Env: PLAYWRIGHT_PATH (where to require playwright from), CDN_DIR, DIST_DIR.

const fs = require('fs');
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');

const APP_URL = process.argv[2] || 'http://localhost:8000/index.html';
const CDN_DIR = process.env.CDN_DIR;

let failures = 0;
const check = (cond, label, detail) => {
	if (cond) console.log(`  ok   ${label}`);
	else { failures++; console.log(`  FAIL ${label}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`); }
};
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

async function newApp(browser, { context } = {}) {
	const ctx = context || await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block' });
	const page = await ctx.newPage();
	page.dialogs = [];          // queue of answers; false = dismiss, null = default value
	page.dialogLog = [];
	page.errors = [];
	page.on('dialog', d => {
		page.dialogLog.push(d.message());
		const a = page.dialogs.length ? page.dialogs.shift() : undefined;
		if (a === false) d.dismiss();
		else if (a === null || a === undefined || a === true) d.accept(d.defaultValue());
		else d.accept(String(a));
	});
	page.on('pageerror', e => page.errors.push(e.message));
	if (CDN_DIR) {
		await page.addInitScript(() => {
			for (const C of [HTMLScriptElement, HTMLLinkElement]) {
				Object.defineProperty(C.prototype, 'integrity', { set() {}, get() { return ''; } });
			}
		});
		await page.route(/cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net/, route => {
			const name = path.basename(new URL(route.request().url()).pathname);
			const file = path.join(CDN_DIR, name);
			if (fs.existsSync(file)) {
				route.fulfill({ body: fs.readFileSync(file), contentType: name.endsWith('.css') ? 'text/css' : 'application/javascript', headers: { 'access-control-allow-origin': '*' } });
			} else route.fulfill({ status: 404, body: '' });
		});
	}
	return page;
}

const open = async (page) => { await page.goto(APP_URL); await page.waitForSelector('#file-list'); await page.waitForTimeout(200); };
const db = (page, name) => page.evaluate(n => new Promise((res, rej) => {
	const ws = JSON.parse(localStorage.getItem('notes_workspaces'))[localStorage.getItem('notes_active_workspace')];
	const r = indexedDB.open(ws.dbName, 1);
	r.onsuccess = () => { const q = r.result.transaction('notes').objectStore('notes').get(n); q.onsuccess = () => { const v = q.result; res(v && { ...v, content: v.content instanceof Blob ? `[Blob ${v.content.type} ${v.content.size}]` : v.content }); }; q.onerror = rej; };
	r.onerror = rej;
}), name);
const listText = (page) => page.$$eval('#file-list li', lis => lis.map(li => li.textContent.trim()));
const header = (page) => page.textContent('#current-filename');
const status = (page) => page.textContent('#status-bar');
const ls = (page, key) => page.evaluate(k => JSON.parse(localStorage.getItem(k) || 'null'), key);
// Settings save on 'change'; blurring the focused input commits it.
const commitInput = (page) => page.evaluate(() => document.activeElement && document.activeElement.blur());
const clickFile = (page, name) => page.click(`#file-list li:has-text("${name}")`);
async function createFile(page, name, text) {
	page.dialogs.push(name);
	await page.click('button:has-text("+ New")');
	await page.waitForTimeout(300);
	if (text !== undefined) {
		await page.fill('#edit-layer textarea', text);
		await page.waitForTimeout(700);
	}
}

async function basics(browser) {
	console.log('basics');
	const page = await newApp(browser);
	await open(page);
	check((await page.textContent('#workspace-indicator')).includes('LOCAL WORKSPACE'), 'default workspace on first boot');
	check(!!(await ls(page, 'notes_workspaces')).ws_default && !!(await ls(page, 'notes_keychains')).kc_default, 'default workspace + keychain persisted');

	await createFile(page, 'a.txt', 'hello world');
	const a = await db(page, 'a.txt');
	check(a && a.content === 'hello world' && a.is_dirty === true, 'typing autosaves to IndexedDB', a);
	check(await header(page) === 'a.txt' && await page.title() === 'a.txt', 'header and title show file');
	check(page.url().endsWith('#github:/@main:a.txt'), 'hash is the open file\'s target (D11)', page.url());
	check((await listText(page)).some(t => t.trim() === 'a.txt'), 'file list shows local-only file without icon', await listText(page));

	await createFile(page, 'notes', 'n');
	check(!!(await db(page, 'notes.txt')), 'extensionless name gets .txt');

	await createFile(page, 'm.md', '# Title\n\nInline $x^2$ and `code`.\n\nEdges: ($a$) $b$\'s 「$c$」 $d$, e `$f$` \\$5 or \\$6\n\n[to a](a.txt)\n\n![pic](pic.png)\n\n```js\nconst q = 1;\n```\n');
	await page.click('#view-toggle');
	await page.waitForSelector('#view-layer h1', { timeout: 5000 }).catch(() => {});
	check(await page.textContent('#view-layer h1').catch(() => null) === 'Title', 'markdown renders heading');
	check(await page.$('#view-layer .katex') !== null, 'markdown renders KaTeX');
	const edges = await page.$eval('#view-layer p:nth-of-type(2)', p => ({ math: p.querySelectorAll('.katex').length, code: p.querySelector('code')?.textContent, text: p.textContent }));
	check(edges.math === 4 && edges.code === '$f$' && /d, e/.test(edges.text) && edges.text.endsWith('$5 or $6'),
		'inline math renders beside punctuation and CJK, not in code or after \\$ (D9)', edges);
	check(await page.$('#view-layer pre code.hljs') !== null, 'markdown highlights code');
	check(await page.getAttribute('#view-layer img', 'alt') === '[Image missing locally: pic.png]', 'missing local image gets placeholder alt');
	check(await page.getAttribute('#view-layer a', 'target') === '_blank', 'links get target=_blank');
	check(await page.textContent('#view-toggle') === '✏️', 'toggle shows edit icon in view mode');

	await page.click('#view-layer a');
	await page.waitForTimeout(300);
	check(await header(page) === 'a.txt', 'relative link opens local file');
	await page.goBack();
	await page.waitForTimeout(400);
	check(await header(page) === 'm.md', 'back button returns to previous file');

	await clickFile(page, 'a.txt');
	await page.waitForTimeout(200);
	check(await page.isVisible('#view-layer pre code') && !(await page.isVisible('#edit-layer textarea')), 'view mode is sticky across files');
	check((await page.textContent('#view-layer pre code').catch(() => '')).includes('hello world'), 'text view mode shows code');
	await page.click('#view-toggle');
	check(await page.isVisible('#edit-layer textarea'), 'toggle back to edit mode');

	// Fuzzy link routing: link to b.html resolves to b.md when that's the only candidate.
	await createFile(page, 'b.md', 'B');
	await createFile(page, 'link.md', '[x](b.html)');
	await page.click('#view-toggle');
	await page.waitForSelector('#view-layer a');
	await page.click('#view-layer a');
	await page.waitForTimeout(300);
	check(await header(page) === 'b.md', 'fuzzy link routing to same basename');

	// Search
	await page.keyboard.press('Control+k');
	check(await page.evaluate(() => document.activeElement.id) === 'search-bar', 'Ctrl+K focuses search');
	await page.fill('#search-bar', 'a.t');
	await page.waitForTimeout(200);
	check(JSON.stringify(await listText(page)) === JSON.stringify(['a.txt']), 'filename filter', await listText(page));
	await page.fill('#search-bar', 'world');
	await page.press('#search-bar', 'Enter');
	await page.waitForTimeout(200);
	const deep = await listText(page);
	check(deep.length === 1 && deep[0].includes('a.txt') && deep[0].includes('1 match'), 'deep search counts content matches', deep);
	await page.fill('#search-bar', '');
	await page.waitForTimeout(200);

	// Upload an image
	page.dialogs.push(null);    // accept default name
	const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
	await page.setInputFiles('#file-upload', { name: 'dot.png', mimeType: 'image/png', buffer: png });
	await page.waitForTimeout(400);
	check(await header(page) === 'dot.png' && await page.$('#view-layer img[src^="blob:"]') !== null, 'uploaded image opens in image viewer');
	check((await db(page, 'dot.png')).content.startsWith('[Blob image/png'), 'uploaded image stored as Blob');
	check(await page.isHidden('#view-toggle'), 'view toggle hidden for view-only plugin');

	// Unsupported binary
	page.dialogs.push(null);
	await page.setInputFiles('#file-upload', { name: 'x.zip', mimeType: 'application/zip', buffer: Buffer.from([1, 2, 3]) });
	await page.waitForTimeout(400);
	check((await page.textContent('#view-layer')).includes('Binary File'), 'unknown binary shows placeholder');

	// Export
	await clickFile(page, 'a.txt');
	await page.waitForTimeout(200);
	const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#save-btn')]);
	check(dl.suggestedFilename() === 'a.txt', 'export downloads current file', dl.suggestedFilename());
	check((await page.textContent('#save-btn')).trim() === '📥 Export', 'export button is labelled Export', await page.textContent('#save-btn'));

	// Pins
	page.dialogs.push('m.md');
	await page.click('button:has-text("📌 Pin")');
	await page.waitForTimeout(100);
	check((await page.textContent('#pin-container')).includes('m.md'), 'pin added');
	check(JSON.stringify(Object.values(await ls(page, 'notes_tree_pins'))) === JSON.stringify([['m.md']]), 'pins persisted per tree');
	await page.click('.pin-tag >> text=m.md');
	await page.waitForTimeout(300);
	check(await header(page) === 'm.md', 'clicking a pin opens the file');
	await page.click('.pin-rm');
	check((await page.textContent('#pin-container')) === '', 'pin removed');

	// Delete a local-only file
	await clickFile(page, 'notes.txt');
	await page.waitForTimeout(200);
	page.dialogs.push(true);
	await page.click('#delete-btn');
	await page.waitForTimeout(300);
	check(!(await db(page, 'notes.txt')) && await header(page) === 'No file selected', 'delete removes local-only file');

	check(page.errors.length === 0, 'no page errors', page.errors);
	await page.context().close();
}

async function pasteCheck(browser) {
	console.log('paste');
	const page = await newApp(browser);
	await open(page);
	page.dialogs.push('images/pasted.png');
	await page.evaluate(() => {
		const dt = new DataTransfer();
		dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'p.png', { type: 'image/png' }));
		document.querySelector('#file-list').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
	});
	await page.waitForTimeout(400);
	const n = await db(page, 'images/pasted.png');
	check(n && n.content.startsWith('[Blob image/png') && n.is_dirty, 'pasted image saved as dirty blob', n);
	await page.context().close();
}

const PANEL = {
	title: 'Home PC',
	controls: [
		{ type: 'heading', label: 'Settings' },
		{ id: 'heater', type: 'number', label: 'Heater target', unit: '°C', min: 15, max: 28, step: 0.5, default: 20 },
		{ id: 'porch_light', type: 'toggle', label: 'Porch light' },
		{ id: 'mode', type: 'select', label: 'Mode', options: ['home', 'away', { value: 'vac', label: 'Vacation' }] },
		{ id: 'message', type: 'text', label: 'Note on the screen' },
		{ id: 'odd', type: 'gizmo', label: 'Unknown type' },
	],
	values: { mode: 'home', porch_light: true, heater: 21 },
};
const panelValues = async (page, name) => JSON.parse((await db(page, name)).content).values;
// Replaces a panel's text through edit mode, then shows the form again.
async function setPanelText(page, text) {
	await page.click('#view-toggle');
	await page.fill('#edit-layer textarea', text);
	await page.waitForTimeout(700);
	await page.click('#view-toggle');
}

async function panelForm(browser) {
	console.log('panel: form');
	const page = await newApp(browser);
	await open(page);
	await createFile(page, 'a.txt', 'plain');
	check(await page.isVisible('#edit-layer textarea'), 'text file opens in edit mode');

	await createFile(page, 'home.panel.json');
	check(await page.isVisible('#view-layer .panel') && await page.textContent('#view-toggle') === '✏️', 'a panel opens as a form even after a file in edit mode');
	check((await page.textContent('#view-layer')).includes('no controls yet'), 'an empty panel says it has no controls');

	await setPanelText(page, JSON.stringify(PANEL, null, '\t'));
	check(await page.textContent('#view-layer .panel-title') === 'Home PC', 'panel title');
	check(await page.inputValue('#panel-heater') === '21' && await page.isChecked('#panel-porch_light'), 'number and toggle show stored values');
	check(await page.$eval('#panel-mode', s => s.selectedOptions[0].textContent) === 'home', 'select shows the stored option');
	check(await page.inputValue('#panel-odd') === '', 'unknown type falls back to a JSON input');

	await page.fill('#panel-heater', '22.5');
	await page.press('#panel-heater', 'Tab');
	await page.waitForTimeout(700);
	let n = await db(page, 'home.panel.json');
	check(JSON.parse(n.content).values.heater === 22.5 && n.is_dirty, 'changing a number saves it into values', n.content);
	check(n.content.includes('\n\t"title"'), 'the file keeps its tab indentation');

	await page.fill('#panel-heater', '40');
	await page.press('#panel-heater', 'Tab');
	await page.waitForTimeout(700);
	check((await page.textContent('.panel-msg')).includes('at most 28') && (await panelValues(page, 'home.panel.json')).heater === 22.5, 'out-of-range input is refused with a message');

	await page.uncheck('#panel-porch_light');
	await page.selectOption('#panel-mode', { label: 'Vacation' });
	await page.fill('#panel-odd', '{"x": [1, 2]}');
	await page.press('#panel-odd', 'Tab');
	await page.waitForTimeout(700);
	const v = await panelValues(page, 'home.panel.json');
	check(v.porch_light === false && v.mode === 'vac' && JSON.stringify(v.odd) === '{"x":[1,2]}', 'toggle, select and raw JSON values are saved', v);

	await page.click('#view-toggle');
	check(JSON.parse(await page.inputValue('#edit-layer textarea')).values.mode === 'vac', 'edit mode shows the updated JSON');
	await page.click('#view-toggle');

	await clickFile(page, 'a.txt');
	await page.waitForTimeout(200);
	check(await page.isVisible('#edit-layer textarea'), 'the next text file still opens in edit mode');

	await clickFile(page, 'home.panel.json');
	await page.waitForTimeout(200);
	await setPanelText(page, '{ broken');
	check((await page.textContent('#view-layer .panel-error').catch(() => '')).startsWith('Invalid JSON'), 'invalid JSON shows an error instead of the form');

	check(page.errors.length === 0, 'no page errors', page.errors);
	await page.context().close();
}

// Command buttons edit the panel file; a status file is a separate, read-only view.
// Nothing here touches the network: syncing is the usual Pull and Push.
async function panelCommandsAndStatus(browser) {
	console.log('panel: commands and status view');
	const page = await newApp(browser);
	const requests = [];
	page.on('request', r => { if (!r.url().startsWith(new URL(APP_URL).origin) && !/cdnjs|jsdelivr/.test(r.url())) requests.push(r.url()); });
	await open(page);

	const panel = {
		title: 'Home PC',
		rev: 1,
		controls: [
			{ id: 'heater', type: 'number', label: 'Heater target', min: 15, max: 28 },
			{ id: 'backup', type: 'button', label: 'Run backup now', confirm: true },
			{ id: 'download', type: 'button', label: 'Download', fields: [{ id: 'url', type: 'text', label: 'URL', required: true, pattern: 'https?://.+' }] },
		],
		values: { heater: 21 },
	};
	await createFile(page, 'home.panel.json');
	await setPanelText(page, JSON.stringify(panel, null, 2));
	const doc = async () => JSON.parse((await db(page, 'home.panel.json')).content);

	await page.fill('#panel-heater', '22');
	await page.press('#panel-heater', 'Tab');
	await page.waitForTimeout(700);
	check((await doc()).rev === 2, 'a value change bumps rev');

	page.dialogs.push(false);
	await page.click('button:has-text("Run backup now")');
	await page.waitForTimeout(700);
	check(!(await doc()).queue, 'cancelling the confirmation queues nothing');

	await page.click('button:has-text("Download")');
	check((await page.textContent('.panel-command:has-text("Download") .panel-msg')) === 'Required.', 'a required argument is checked before queuing');
	await page.fill('.panel-arg input', 'ftp://x');
	await page.press('.panel-arg input', 'Tab');
	await page.click('button:has-text("Download")');
	check((await page.textContent('.panel-command:has-text("Download") .panel-msg')) === 'Not in the expected format.', 'argument pattern is checked');
	await page.fill('.panel-arg input', 'https://example.com/a.pdf');
	await page.press('.panel-arg input', 'Tab');
	await page.click('button:has-text("Download")');
	await page.waitForTimeout(700);
	let d = await doc();
	const entry = d.queue && d.queue[0];
	check(entry && entry.command === 'download' && entry.args.url === 'https://example.com/a.pdf' && /^c-\d{8}T\d{6}-[0-9a-z]{6}$/.test(entry.id) && entry.rev === 3 && d.rev === 3, 'a command is queued in the file with id, args and rev', d);
	const hist = await page.textContent('.panel-command:has-text("Download") .panel-history');
	check(hist.includes('queued') && hist.includes('example.com'), 'the button shows its queued entry', hist);
	check((await page.textContent('#view-layer .panel-strip')).includes('No home.status.json on this device yet'), 'without a stored status file, the form says so');
	check((await db(page, 'home.panel.json')).is_dirty && (await listText(page)).some(t => t.includes('home.panel.json')), 'the panel waits for Push like any edited file');

	page.dialogs.push(true);
	await page.click('button:has-text("Run backup now")');
	await page.waitForTimeout(700);
	check((await doc()).queue.map(e => e.command).join() === 'download,backup', 'a confirmed command is queued after the others');

	// The status file, written by the program, opened on its own.
	const status = {
		updated: new Date(Date.now() - 30e3).toISOString(), heartbeat_seconds: 60, rev: 3,
		values: { heater: 22 }, errors: { mode: 'unknown mode' },
		results: { [entry.id]: { state: 'failed', at: new Date().toISOString(), output: 'timed out after 2 s' } },
		report: { 'Disk free': 'line 1\nline 2', Disk: { type: 'meter', value: 82, unit: '%' } },
	};
	await createFile(page, 'home.status.json');
	await page.click('#view-toggle');
	await page.fill('#edit-layer textarea', JSON.stringify(status));
	await page.waitForTimeout(700);
	await page.click('#view-toggle');
	const view = await page.textContent('#view-layer');
	check(/Online · updated 3\d s ago · panel rev 3/.test(view), 'status view: liveness from the file\'s own time', view.slice(0, 120));
	check(view.includes('heater') && view.includes('⚠️ unknown mode') && view.includes('failed') && view.includes('timed out after 2 s'), 'status view: values, errors and command results', view);
	check(await page.$('#view-layer .panel-report meter') !== null && await page.$('#view-layer .panel-pre') !== null, 'status view: report widgets');
	check(await page.$('#view-layer input, #view-layer select, #view-layer button') === null, 'status view is read-only');

	// The panel reads its status file, derived from its name, through the plugin host.
	await clickFile(page, 'home.panel.json');
	await page.waitForTimeout(300);
	const strip = await page.textContent('#view-layer .panel-strip');
	check(/Online · updated 3\d s ago · panel rev 3/.test(strip) && strip.includes('home.status.json'), 'the form shows the status file\'s liveness', strip);
	check(await page.textContent('.panel-row:has(#panel-heater) .panel-badge') === '✓ Applied', 'a reported value that matches shows as applied');
	const runs = await page.textContent('.panel-command:has-text("Download") .panel-history');
	check(runs.includes('failed') && runs.includes('timed out after 2 s'), 'a command shows its result from the status file', runs);
	check((await page.textContent('.panel-command:has-text("Run backup now") .panel-history')).includes('waiting'), 'a command the program has not seen is waiting');
	check((await page.textContent('#view-layer')).includes('Disk free'), 'the status report is shown under the form');

	// A newer status stored while the form is open (as a pull would) updates it in place.
	await page.fill('#panel-heater', '2');
	const backupId = (await doc()).queue.find(e => e.command === 'backup').id;
	await page.evaluate(([text]) => define.require('storage/notesDb').put({ filename: 'home.status.json', content: text, last_synced_sha: 's', remote_sha: 's', is_dirty: false }),
		[JSON.stringify({ ...status, rev: 4, values: { heater: 25 }, results: { ...status.results, [backupId]: { state: 'done', at: new Date().toISOString() } } })]);
	await page.waitForTimeout(700);
	check(await page.textContent('.panel-row:has(#panel-heater) .panel-badge') === 'Reported: 25', 'a newer stored status updates the badges', await page.textContent('.panel-row:has(#panel-heater) .panel-badge'));
	check((await page.textContent('.panel-command:has-text("Run backup now") .panel-history')).includes('done'), 'and the command results');
	check(await page.inputValue('#panel-heater') === '2' && await page.evaluate(() => document.activeElement.id) === 'panel-heater', 'without rebuilding the input being typed in');
	await page.press('#panel-heater', 'Escape');

	check(requests.length === 0, 'no network requests', requests);
	check(page.errors.length === 0, 'no page errors', page.errors);
	await page.context().close();
}

// Local images are read through the plugin host, and refreshed when one is
// stored later, in this tab or another.
async function markdownImages(browser) {
	console.log('markdown: images through the host');
	const ctx = await browser.newContext({ serviceWorkers: 'block' });
	const page = await newApp(browser, { context: ctx });
	await open(page);
	await createFile(page, 'notes/m.md', '# M\n\n![pic](../img/pic.png)\n\n![spaced](<my pic.png>)\n\n![up](../../up.png)\n');
	await page.click('#view-toggle');
	await page.waitForSelector('#view-layer h1', { timeout: 5000 }).catch(() => {});
	const alts = () => page.$$eval('#view-layer img', imgs => imgs.map(i => i.getAttribute('alt')));
	const srcs = () => page.$$eval('#view-layer img', imgs => imgs.map(i => i.getAttribute('src') || ''));
	check(JSON.stringify(await alts()) === JSON.stringify(['[Image missing locally: ../img/pic.png]', '[Image missing locally: my pic.png]', '[Image missing locally: ../../up.png]']), 'images not stored yet are marked missing', await alts());

	page.dialogs.push('img/pic.png');
	await page.evaluate(() => {
		const dt = new DataTransfer();
		dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'p.png', { type: 'image/png' }));
		document.querySelector('#file-list').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
	});
	await page.waitForTimeout(900);
	check((await srcs())[0].startsWith('blob:') && await header(page) === 'notes/m.md', 'an image saved after the note is open appears without reopening', await srcs());

	const p2 = await newApp(browser, { context: ctx });
	await open(p2);
	p2.dialogs.push('notes/my pic.png');
	await p2.setInputFiles('#file-upload', { name: 'x.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71]) });
	await page.waitForTimeout(900);
	check((await srcs())[1].startsWith('blob:'), 'an image stored in another tab appears too, from a path with a space', await srcs());
	check((await alts())[2] === '[Image missing locally: ../../up.png]', 'a path above the repo root stays missing');

	const refused = await page.evaluate(() => define.require('ui/editor').activePlugin().host.read('../../../x.txt').then(() => 'read', e => e.message));
	check(refused.includes('outside the repository'), 'the host refuses a path above the repo root', refused);

	check(page.errors.length === 0 && p2.errors.length === 0, 'no page errors', [...page.errors, ...p2.errors]);
	await ctx.close();
}

async function settingsAndGithub(browser) {
	console.log('settings + github');
	const page = await newApp(browser);
	const requests = [];
	let remoteFile = { content: '# R', sha: 's1' };
	let remoteGone = false;  // remote.md deleted on the remote (D5)
	await page.route('https://api.github.com/**', async route => {
		const req = route.request();
		const u = new URL(req.url());
		requests.push({ method: req.method(), path: u.pathname + u.search, auth: req.headers()['authorization'], body: req.postData() });
		const json = (o, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(o), headers: { 'access-control-allow-origin': '*' } });
		if (u.pathname === '/repos/o/r/git/trees/main:docs' && req.method() === 'GET') return json({ tree: [{ path: 'x.txt', type: 'blob', sha: 'sx', size: 1 }] });
		if (u.pathname === '/repos/o/r/git/trees/main:' && req.method() === 'GET') {
			return json({ tree: [
				...(remoteGone ? [] : [{ path: 'remote.md', type: 'blob', sha: remoteFile.sha, size: 3 }]),
				{ path: 'pic.png', type: 'blob', sha: 'listed-before-a-change', size: 4 },
				{ path: 'docs/x.txt', type: 'blob', sha: 'sx', size: 1 },
				{ path: 'docs', type: 'tree', sha: 'sd' },
			] });
		}
		if (u.pathname === '/repos/o/r/contents/pic.png' && req.method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: Buffer.from([137, 80, 78, 71]), headers: { 'access-control-allow-origin': '*' } });
		if (u.pathname === '/repos/o/r/contents/remote.md' && req.method() === 'GET') return json({ content: b64(remoteFile.content), sha: remoteFile.sha });
		if (u.pathname === '/repos/o/r/contents/remote.md' && req.method() === 'PUT') return json({ content: { sha: 's3' } });
		if (u.pathname === '/repos/o/r/contents/remote.md' && req.method() === 'DELETE') return json({});
		if (u.pathname === '/repos/o/r/contents/' && req.method() === 'GET') return json([{ name: 'docs', sha: 'sd', type: 'dir' }, { name: 'top.md', sha: 'st', type: 'file', size: 1 }, { name: 'remote.md', sha: remoteFile.sha, type: 'file', size: 3 }]);
		if (u.pathname === '/repos/o/r/contents/docs' && req.method() === 'GET') return json([{ name: 'x.txt', sha: 'sx', type: 'file', size: 1 }, { name: 'sub', sha: 'ss', type: 'dir' }]);
		return json({ message: 'not mocked' }, 404);
	});
	await open(page);

	await page.click('button:has-text("Setup")');
	check(await header(page) === 'Settings & Profiles', 'settings opens');
	const built = await page.textContent('.build-info').catch(() => '');
	check(/^Built \d{4}-\d\d-\d\d \d\d:\d\d UTC/.test(built), 'settings shows the build date', built);
	check((await page.getAttribute('#workspace-indicator', 'title')).endsWith(`\n\n${built}`), 'workspace tooltip shows the build date');
	check(await page.$$eval('.profile-card', e => e.length) === 1 && await page.$$eval('.tree-group', e => e.length) === 1, 'one keychain card and one tree');
	page.dialogs.push('Work');
	await page.click('button:has-text("+ New Keychain")');
	check(await page.$$eval('.profile-card', e => e.length) === 2, 'new keychain card');
	check(Object.values(await ls(page, 'notes_keychains')).some(k => k.name === 'Work'), 'new keychain persisted');
	page.dialogs.push(true);
	await page.click('.profile-card:nth-of-type(2) .btn-delete, .profile-card >> nth=1 >> .btn-delete');
	await page.waitForTimeout(100);
	check(await page.$$eval('.profile-card', e => e.length) === 1, 'keychain deleted');

	await page.fill('.kc-token', 'tok');
	await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
	await page.click('.btn-token-copy');
	await page.waitForTimeout(100);
	check(await page.evaluate(() => navigator.clipboard.readText()) === 'tok', 'Copy puts the PAT on the clipboard');
	check(await status(page) === 'Token copied.', 'status confirms the copy without the token', await status(page));
	await page.click('.btn-token-toggle');
	check(await page.getAttribute('.kc-token', 'type') === 'text' && await page.textContent('.btn-token-toggle') === 'Hide', 'Show reveals the PAT');
	await page.click('.btn-token-toggle');
	check(await page.getAttribute('.kc-token', 'type') === 'password', 'Hide masks it again');
	await page.fill('.tree-owner', 'o');
	await page.fill('.tree-repo', 'r');
	check((await page.textContent('.tree-title')).includes('o / r'), 'tree title follows owner/repo');
	check((await ls(page, 'notes_workspaces')).ws_default.repo === '', 'typing alone does not save yet');
	await commitInput(page);
	const ws = (await ls(page, 'notes_workspaces')).ws_default;
	check(ws.owner === 'o' && ws.repo === 'r' && (await ls(page, 'notes_keychains')).kc_default.token === 'tok', 'settings save on change');
	check(await page.isVisible('.settings-saved') && await page.$('.settings-save-btn') === null, 'quiet "Saved ✓" instead of a Save button');

	await page.click('button:has-text("Refresh List")');
	await page.waitForTimeout(400);
	const lt = await listText(page);
	check(lt.includes('⬇️ remote.md') && lt.includes('⬇️ docs/x.txt'), 'refresh lists remote files with update icon', lt);
	check(requests[0] && requests[0].auth === 'token tok' && requests[0].path === '/repos/o/r/git/trees/main:?recursive=1', 'deep tree request', requests[0]);

	await clickFile(page, 'remote.md');
	await page.waitForTimeout(200);
	await page.click('#pull-btn');
	await page.waitForTimeout(400);
	check(await page.inputValue('#edit-layer textarea') === '# R', 'pull fills editor');
	let n = await db(page, 'remote.md');
	check(n.content === '# R' && !n.is_dirty && n.last_synced_sha === 's1', 'pull updates local note', n);
	check((await listText(page)).includes('🟢 remote.md'), 'synced icon');

	// A binary pull records the git blob sha of the bytes it got, not the listed sha (C6).
	await clickFile(page, 'pic.png');
	await page.waitForTimeout(200);
	await page.click('#pull-btn');
	await page.waitForTimeout(400);
	const pic = await db(page, 'pic.png');
	const picSha = require('crypto').createHash('sha1').update(Buffer.concat([Buffer.from('blob 4\0'), Buffer.from([137, 80, 78, 71])])).digest('hex');
	check(pic.content.startsWith('[Blob image/png 4') && pic.last_synced_sha === picSha && pic.remote_sha === picSha, 'binary pull records the blob sha of the bytes', pic);
	await clickFile(page, 'remote.md');
	await page.waitForTimeout(200);
	await page.click('#view-toggle');   // the image viewer left the editor in view mode
	await page.waitForTimeout(200);

	await page.fill('#edit-layer textarea', '# R edited');
	await page.waitForTimeout(700);
	check((await listText(page)).includes('🟡 remote.md'), 'dirty icon');
	await page.click('#push-btn');
	await page.waitForTimeout(400);
	const put = requests.find(r => r.method === 'PUT');
	const body = put && JSON.parse(put.body);
	check(body && body.sha === 's1' && body.branch === 'main' && body.message === 'Update remote.md' && Buffer.from(body.content, 'base64').toString() === '# R edited', 'push sends content + sha', body);
	n = await db(page, 'remote.md');
	check(!n.is_dirty && n.last_synced_sha === 's3', 'push marks clean with new sha', n);

	// Deleted on the remote: Refresh makes it local-only, and Push creates it again (D5).
	remoteGone = true;
	await page.click('button:has-text("Refresh List")');
	await page.waitForTimeout(400);
	n = await db(page, 'remote.md');
	check((await listText(page)).includes('remote.md') && n.remote_sha === null && n.last_synced_sha === null && n.is_dirty && n.content === '# R edited', 'deleted remotely: local-only, content kept', n);
	check((await status(page)).includes('1 file deleted remotely is now local-only'), 'refresh says so', await status(page));
	remoteGone = false;
	await page.click('#push-btn');
	await page.waitForTimeout(400);
	const recreate = requests.filter(r => r.method === 'PUT').at(-1);
	check(recreate && !JSON.parse(recreate.body).sha, 'push re-creates it without a sha', recreate && recreate.body);
	check((await listText(page)).includes('🟢 remote.md'), 'synced again after the push');

	// Commit message prompt
	await page.evaluate(() => {});
	await page.click('button:has-text("Setup")');
	// D4: pins follow the tree when its branch is renamed.
	const pinsBefore = await ls(page, 'notes_tree_pins');
	await page.evaluate(() => {
		const pins = JSON.parse(localStorage.getItem('notes_tree_pins') || '{}');
		pins['github|https://api.github.com|o|r|main'] = ['remote.md'];
		localStorage.setItem('notes_tree_pins', JSON.stringify(pins));
	});
	await page.reload();
	await page.waitForSelector('#file-list');
	await page.click('button:has-text("Setup")');
	await page.fill('.tree-branch', 'dev');
	await commitInput(page);
	let pins = await ls(page, 'notes_tree_pins');
	check(JSON.stringify(pins['github|https://api.github.com|o|r|dev']) === '["remote.md"]' && !pins['github|https://api.github.com|o|r|main'], 'renaming the branch moves the tree\'s pins', pins);
	await page.fill('.tree-branch', 'main');
	await commitInput(page);
	pins = await ls(page, 'notes_tree_pins');
	check(JSON.stringify(pins['github|https://api.github.com|o|r|main']) === '["remote.md"]', 'and back', pins);
	check((await page.textContent('#pin-container')).includes('remote.md'), 'pin still shown');
	await page.evaluate((p) => localStorage.setItem('notes_tree_pins', JSON.stringify(p)), pinsBefore || {});
	await page.reload();
	await page.waitForSelector('#file-list');
	await page.click('button:has-text("Setup")');
	await page.check('.tree-askCommit');
	check((await ls(page, 'notes_workspaces')).ws_default.askForCommitMsg === true, 'checkbox saves immediately');
	await clickFile(page, 'remote.md');
	await page.waitForTimeout(200);
	await page.fill('#edit-layer textarea', '# R again');
	await page.waitForTimeout(700);
	page.dialogs.push('my message');
	await page.keyboard.press('Control+s');
	await page.waitForTimeout(400);
	const put2 = requests.filter(r => r.method === 'PUT').at(-1);
	check(put2 && JSON.parse(put2.body).message === 'my message' && JSON.parse(put2.body).sha === 's3', 'Ctrl+S pushes with prompted commit message', put2 && JSON.parse(put2.body));

	// Conflict: local dirty, remote changed -> overwrite with remote
	await page.fill('#edit-layer textarea', 'local change');
	await page.waitForTimeout(700);
	remoteFile = { content: 'remote change', sha: 's4' };
	page.dialogs.push('w');
	await page.click('#pull-btn');
	await page.waitForTimeout(400);
	check(page.dialogLog.some(m => m.startsWith('Conflict in remote.md!')), 'conflict prompt shown');
	n = await db(page, 'remote.md');
	check(n.content === 'remote change' && !n.is_dirty && n.last_synced_sha === 's4', 'conflict "w" takes remote', n);

	// Conflict: diff markers
	await page.fill('#edit-layer textarea', 'a\nB\n');
	await page.waitForTimeout(700);
	remoteFile = { content: 'a\nb\n', sha: 's5' };
	page.dialogs.push('d');
	await page.click('#pull-btn');
	await page.waitForTimeout(800);
	n = await db(page, 'remote.md');
	check(n.is_dirty && n.content === 'a\n<<<<<<< LOCAL\nB\n=======\nb\n>>>>>>> REMOTE\n', 'conflict "d" inserts one balanced hunk', n.content);
	page.markerOutput = n.content;

	// Delete synced file -> remote DELETE with sha
	page.dialogs.push(true);
	await page.click('#delete-btn');
	await page.waitForTimeout(300);
	const del = requests.find(r => r.method === 'DELETE');
	check(del && JSON.parse(del.body).sha === 's5' && JSON.parse(del.body).message === 'Delete note: remote.md', 'delete sends remote DELETE with sha', del && del.body);
	check(page.dialogLog.includes('Delete remote.md from local AND remote?'), 'delete confirm mentions remote');

	// Mount point
	await page.click('button:has-text("Setup")');
	page.dialogs.push('docs');
	await page.click('button:has-text("+ Add Mount Point")');
	check(await page.$$eval('.mount-row', e => e.length) === 2, 'mount point row added');
	check(await page.isVisible('.mount-row >> nth=0 >> .leaf-warning') || await page.isVisible('.mount-row >> nth=1 >> .leaf-warning'), 'parent mount shows shallow warning');
	const wss = await ls(page, 'notes_workspaces');
	const mountId = Object.keys(wss).find(id => wss[id].rootDir === 'docs');
	check(mountId && wss[mountId].name === 'Local Workspace (docs)' && wss.ws_default.shallow === true, 'mount persisted; parent forced shallow', wss);

	await page.click('button:has-text("Refresh List")');
	await page.waitForTimeout(300);
	check(requests.some(r => r.path === '/repos/o/r/contents/?ref=main'), 'shallow refresh uses contents API', requests.map(r => r.path));

	const rootList = await listText(page);
	check(rootList.some(t => t.includes('🗂️ docs/')) && rootList.includes('⬇️ top.md'), 'shallow listing; mount shows as folder', rootList);
	check(!rootList.some(t => t.includes('docs/x.txt')) && !(await db(page, 'docs/x.txt')), 'shallow refresh drops the clean nested copy the mount owns (D7)', rootList);
	await clickFile(page, '🗂️ docs/');
	await page.waitForTimeout(300);
	check((await page.textContent('#workspace-indicator')).includes('(DOCS)'), 'clicking mount switches workspace');
	check((await listText(page))[0] === '🔙 ../', 'parent navigation shown');
	await page.click('button:has-text("Refresh List")');
	await page.waitForTimeout(300);
	check(requests.some(r => r.path === '/repos/o/r/git/trees/main:docs?recursive=1'), 'mount refresh is rooted at docs', requests.map(r => r.path));
	await page.click('#file-list li.parent-nav');
	await page.waitForTimeout(300);
	check((await page.textContent('#workspace-indicator')).includes('LOCAL WORKSPACE') && !(await page.textContent('#workspace-indicator')).includes('DOCS'), '../ returns to parent');

	// Pin across mounts: pin docs/x.txt from root, opens in docs workspace
	page.dialogs.push('docs/x.txt');
	await page.click('button:has-text("📌 Pin")');
	await page.click('.pin-tag >> text=docs/x.txt');
	await page.waitForTimeout(400);
	check((await page.textContent('#workspace-indicator')).includes('(DOCS)'), 'pin resolves to deepest mount');
	check(await header(page) === 'x.txt', 'pin opens relative file in mount', await header(page));
	check(page.url().endsWith('#github:o/r@main:docs/x.txt'), 'hash names the repo and the path from its root (D11)', page.url());
	await page.goBack();
	await page.waitForTimeout(300);
	check(page.url().endsWith('#github:o/r@main:docs'), 'back to the switch into the docs mount', page.url());

	// A deep link opens the right mount and file after a reload (D11).
	await page.goto(APP_URL.replace(/#.*$/, '') + '#github:o/r@main:docs/x.txt');
	await page.reload();
	await page.waitForSelector('#file-list');
	await page.waitForTimeout(400);
	check((await page.textContent('#workspace-indicator')).includes('(DOCS)') && await header(page) === 'x.txt', 'reload on a deep link opens the mount and the file', await header(page));
	// The service-worker check may overwrite the status bar later, so record it.
	await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => {
		window.statusLog = [];
		new MutationObserver(() => window.statusLog.push(document.getElementById('status-bar').textContent))
			.observe(document.getElementById('status-bar'), { childList: true, subtree: true, characterData: true });
	}));
	await page.goto(APP_URL.replace(/#.*$/, '') + '#github:o/r@nope:x.txt');
	await page.reload();
	await page.waitForSelector('#file-list');
	await page.waitForTimeout(300);
	const statusLog = await page.evaluate(() => window.statusLog);
	check(statusLog.some(t => t.includes('No workspace for "github:o/r@nope:x.txt"')), 'an unknown origin is named', statusLog);

	// Symlink
	await page.click('button:has-text("Setup")');
	await page.check('.symlink-mode-label input');
	await page.click('#file-list li:has-text("../")').catch(() => {});
	await page.waitForTimeout(300);
	await createFile(page, 'go.symlink', 'github:o/r@main:docs');
	await createFile(page, 'file.symlink', './docs/x.txt');
	await page.click('button:has-text("Setup")');
	await page.uncheck('.symlink-mode-label input');
	await clickFile(page, 'file.symlink');
	await page.waitForTimeout(400);
	check((await page.textContent('#workspace-indicator')).includes('(DOCS)') && await header(page) === 'x.txt', 'a relative symlink opens a file in another mount (E8)', await header(page));
	await page.click('#file-list li.parent-nav');
	await page.waitForTimeout(300);
	await clickFile(page, 'go.symlink');
	await page.waitForTimeout(300);
	check((await page.textContent('#workspace-indicator')).includes('(DOCS)'), 'a symlink to a mount switches workspace');

	// Clear DB of the active mount
	page.dialogs.push(true);
	await page.click('button:has-text("Setup")');
	await page.click('.mount-row.active .btn-clear');
	await page.waitForTimeout(300);
	check((await listText(page)).filter(t => !t.includes('../')).length === 0, 'clear DB empties list', await listText(page));

	// Delete the mount workspace
	page.dialogs.push(true);
	await page.click('button:has-text("Setup")');
	await page.click('.mount-row.active .btn-delete');
	await page.waitForTimeout(300);
	check(Object.keys(await ls(page, 'notes_workspaces')).length === 1, 'workspace deleted');
	check((await ls(page, 'notes_workspaces')).ws_default.shallow === true && !(await page.isDisabled('.mount-row .ws-shallow')) && await page.isChecked('.mount-row .ws-shallow'),
		'parent stays shallow, and the box can be unticked again (D7)');

	// Two mounts at the root are siblings: neither forces the other shallow (D7).
	await page.uncheck('.mount-row .ws-shallow');
	page.dialogs.push('/');
	await page.click('button:has-text("+ Add Mount Point")');
	await page.waitForTimeout(200);
	const both = Object.values(await ls(page, 'notes_workspaces'));
	check(both.length === 2 && both.every(w => w.shallow === false) && !(await page.isVisible('.leaf-warning')), 'two / mounts stay deep', both.map(w => [w.rootDir, w.shallow]));

	check(page.errors.length === 0, 'no page errors', page.errors);
	await page.context().close();
	return page.markerOutput;
}

async function dropbox(browser) {
	console.log('dropbox');
	const page = await newApp(browser);
	const calls = [];
	await page.route('https://www.dropbox.com/**', route => { calls.push(route.request().url()); route.fulfill({ status: 200, body: 'authorize page' }); });
	await page.route('https://api.dropboxapi.com/**', async route => {
		const req = route.request(); const u = new URL(req.url());
		calls.push(u.pathname + ' ' + (req.postData() || ''));
		const json = (o, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(o), headers: { 'access-control-allow-origin': '*' } });
		if (u.pathname === '/oauth2/token') return json({ access_token: 'AT', refresh_token: 'RT' });
		if (u.pathname === '/2/files/list_folder') return json({ entries: [{ '.tag': 'file', path_display: '/Notes/n.md', rev: 'r1', size: 2 }, { '.tag': 'folder', path_display: '/Notes/sub', id: 'id:1' }], has_more: false });
		return json({}, 404);
	});
	await page.route('https://content.dropboxapi.com/**', route => {
		calls.push('content ' + route.request().headers()['dropbox-api-arg']);
		route.fulfill({ status: 200, body: 'hi', headers: { 'dropbox-api-result': JSON.stringify({ rev: 'r1' }), 'access-control-allow-origin': '*', 'access-control-expose-headers': 'Dropbox-API-Result' } });
	});
	await open(page);
	await page.click('button:has-text("Setup")');
	await page.selectOption('.kc-provider', 'dropbox');
	await page.fill('.kc-appkey', 'KEY');
	await page.click('.btn-link-dbx');
	await page.waitForTimeout(500);
	const auth = calls.find(c => c.startsWith('https://www.dropbox.com/oauth2/authorize'));
	check(auth && auth.includes('client_id=KEY') && auth.includes('code_challenge_method=S256') && auth.includes('token_access_type=offline'), 'link redirects to Dropbox authorize', auth);
	check(/^[0-9a-f]{20,}$/.test(new URL(auth).searchParams.get('state') || ''), 'authorize carries a random state (E4)', auth);

	// A reply with another state is refused, and uses up the stored request.
	page.dialogs.push(true);
	await page.goto(APP_URL + '?code=EVIL&state=other');
	await page.waitForTimeout(400);
	check(page.dialogLog.some(m => m.includes('does not match')) && !calls.some(c => c.startsWith('/oauth2/token')), 'a mismatched state is refused before any token request (E4)', page.dialogLog);
	check(!(await ls(page, 'notes_keychains')).kc_default.token, 'no token stored');

	await page.click('button:has-text("Setup")');
	await page.click('.btn-link-dbx');
	await page.waitForTimeout(500);
	const state = new URL(calls.filter(c => c.startsWith('https://www.dropbox.com/oauth2/authorize')).at(-1)).searchParams.get('state');
	await page.goto(APP_URL + `?code=CODE&state=${state}`);
	await page.waitForTimeout(500);
	const kc = (await ls(page, 'notes_keychains')).kc_default;
	check(kc.provider === 'dropbox' && kc.token === 'AT' && kc.refreshToken === 'RT', 'redirect exchanges code for tokens', kc);
	const tokenCall = calls.find(c => c.startsWith('/oauth2/token'));
	check(tokenCall && tokenCall.includes('grant_type=authorization_code') && tokenCall.includes('code=CODE') && tokenCall.includes('code_verifier='), 'token request uses PKCE verifier', tokenCall);
	check(!page.url().includes('code='), 'code removed from URL');

	await page.evaluate(() => {
		const w = JSON.parse(localStorage.getItem('notes_workspaces'));
		w.ws_default.rootDir = 'Notes';
		localStorage.setItem('notes_workspaces', JSON.stringify(w));
	});
	await page.reload();
	await page.waitForTimeout(300);
	await page.click('button:has-text("Refresh List")');
	await page.waitForTimeout(400);
	check((await listText(page)).includes('⬇️ n.md'), 'dropbox refresh strips root', await listText(page));
	check(calls.some(c => c.startsWith('/2/files/list_folder') && c.includes('"path":"/Notes"') && c.includes('"recursive":true')), 'list_folder request', calls);
	await clickFile(page, 'n.md');
	await page.waitForTimeout(200);
	await page.click('#pull-btn');
	await page.waitForTimeout(400);
	check(await page.inputValue('#edit-layer textarea') === 'hi', 'dropbox pull', await status(page));
	check(calls.some(c => c === 'content {"path":"/Notes/n.md"}'), 'download arg', calls);
	check(page.errors.length === 0, 'no page errors', page.errors);
	await page.context().close();
}

// A tiny in-memory remoteStorage server behind page.route(): folder listings
// with ETags, conditional PUT and DELETE.
async function remoteStorage(browser) {
	console.log('remoteStorage');
	const page = await newApp(browser);
	const STORAGE = 'https://rs.example/storage/';
	const docs = new Map([['n.md', { body: 'hi', etag: 'e1' }], ['sub/x.txt', { body: 'x', etag: 'e2' }]]);
	let version = 2;
	const calls = [];
	const folderEtag = (prefix) => [...docs].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => k + v.etag).join(',');
	await page.route(STORAGE + '**', async route => {
		const req = route.request();
		const rel = decodeURIComponent(new URL(req.url()).pathname.slice('/storage/'.length));
		const h = req.headers();
		calls.push(`${req.method()} /${rel} ${h['authorization'] || ''} ${h['if-match'] || ''}${h['if-none-match'] || ''}`);
		const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'ETag' };
		const reply = (status, body = '', headers = {}) => route.fulfill({ status, body, headers: { ...cors, ...headers } });
		if (h['authorization'] !== 'Bearer RSTOK') return reply(401);
		if (rel === '' || rel.endsWith('/')) {
			const etag = `"${folderEtag(rel)}"`;
			if (h['if-none-match'] === etag) return reply(304, '', { etag });
			const items = {};
			for (const [k, v] of docs) {
				if (!k.startsWith(rel)) continue;
				const rest = k.slice(rel.length);
				if (rest.includes('/')) { const sub = rest.split('/')[0] + '/'; items[sub] = { ETag: folderEtag(rel + sub) }; }
				else items[rest] = { ETag: v.etag, 'Content-Type': 'text/plain', 'Content-Length': v.body.length };
			}
			return reply(200, JSON.stringify({ '@context': 'http://remotestorage.io/spec/folder-description', items }), { 'content-type': 'application/ld+json', etag });
		}
		const doc = docs.get(rel);
		if (req.method() === 'GET') return doc ? reply(200, doc.body, { etag: `"${doc.etag}"`, 'content-type': 'text/plain' }) : reply(404);
		if (req.method() === 'PUT') {
			if (h['if-none-match'] === '*' ? doc : (!doc || h['if-match'] !== `"${doc.etag}"`)) return reply(412);
			const etag = `e${++version}`;
			docs.set(rel, { body: req.postData() || '', etag });
			return reply(doc ? 200 : 201, '', { etag: `"${etag}"` });
		}
		return reply(405);
	});
	await open(page);
	await page.click('button:has-text("Setup")');
	await page.selectOption('.kc-provider', 'remotestorage');
	check(await page.textContent('.kc-token-label') === 'Bearer Token', 'token label for remoteStorage');
	await page.selectOption('.tree-keychain', { index: 0 });
	check(!(await page.isVisible('.tree-owner')) && !(await page.isVisible('.tree-askCommit')), 'repo fields and commit toggle hidden');
	await page.fill('.kc-token', 'RSTOK');
	await page.fill('.tree-host', STORAGE);
	await commitInput(page);
	await page.waitForTimeout(100);
	check((await page.textContent('.tree-title')).includes('remoteStorage'), 'tree title names remoteStorage', await page.textContent('.tree-title'));

	await page.click('button:has-text("Refresh List")');
	await page.waitForTimeout(400);
	const list = await listText(page);
	check(list.includes('⬇️ n.md') && list.some(t => t.includes('x.txt')), 'refresh walks folders', list);
	calls.length = 0;
	await page.click('button:has-text("Refresh List")');
	await page.waitForTimeout(400);
	check(calls.length === 1 && calls[0].startsWith('GET / ') && calls[0].includes('"'), 'second refresh: one revalidated listing', calls);

	await clickFile(page, 'n.md');
	await page.waitForTimeout(200);
	await page.click('#pull-btn');
	await page.waitForTimeout(400);
	check(await page.inputValue('#edit-layer textarea') === 'hi', 'remoteStorage pull', await status(page));
	await page.fill('#edit-layer textarea', 'hi there');
	await page.waitForTimeout(700);
	calls.length = 0;
	await page.click('#push-btn');
	await page.waitForTimeout(400);
	check(docs.get('n.md').body === 'hi there' && calls.some(c => c.startsWith('PUT /n.md') && c.endsWith('"e1"')), 'push sends If-Match', calls);
	check(page.dialogLog.length === 0, 'no commit-message prompt', page.dialogLog);
	const n = await db(page, 'n.md');
	check(!n.is_dirty && n.last_synced_sha === docs.get('n.md').etag, 'push records the new ETag', n);

	docs.set('n.md', { body: 'changed elsewhere', etag: 'e99' });
	await page.fill('#edit-layer textarea', 'mine');
	await page.waitForTimeout(700);
	await page.click('#push-btn');
	await page.waitForTimeout(400);
	check((await status(page)).includes('Pull first') && docs.get('n.md').body === 'changed elsewhere', 'stale push refused', await status(page));

	check(page.errors.length === 0, 'no page errors', page.errors);
	await page.context().close();
}

async function crossTab(browser) {
	console.log('cross-tab');
	const ctx = await browser.newContext({ serviceWorkers: 'block' });
	const p1 = await newApp(browser, { context: ctx });
	await open(p1);
	await createFile(p1, 'shared.txt', 'one');
	const p2 = await newApp(browser, { context: ctx });
	await open(p2);
	await clickFile(p2, 'shared.txt');
	await p2.waitForTimeout(200);
	await p1.fill('#edit-layer textarea', 'one two');
	await p1.waitForTimeout(800);
	check((await status(p2)).includes('Edited in another tab'), 'other tab warned');
	check(await p2.isDisabled('#edit-layer textarea') && await p2.isDisabled('#push-btn'), 'other tab frozen');
	check((await listText(p2)).some(t => t.includes('shared.txt')), 'sidebar still lists file');
	await ctx.close();
}

async function editRaces(browser) {
	console.log('edit races');
	const page = await newApp(browser);
	await open(page);

	// A1: the autosave timer must write into the file it was typed in.
	await createFile(page, 'a.txt', 'A');
	await createFile(page, 'b.txt', 'B');
	await page.fill('#edit-layer textarea', 'B typed');
	await clickFile(page, 'a.txt');          // well inside the 500 ms debounce
	await page.waitForTimeout(800);
	let a = await db(page, 'a.txt'), b = await db(page, 'b.txt');
	check(a.content === 'A' && b.content === 'B typed', 'type then switch file: edit lands in the file it was typed in', [a.content, b.content]);
	check(await page.inputValue('#edit-layer textarea') === 'A', 'switched file shows its own content');

	// Switching straight back must show the edit, not the stale stored copy.
	await page.fill('#edit-layer textarea', 'A typed');
	await clickFile(page, 'b.txt');
	await clickFile(page, 'a.txt');
	await page.waitForTimeout(300);
	check(await page.inputValue('#edit-layer textarea') === 'A typed', 'type, switch away and back: editor shows the edit');

	// Leaving for Settings saves too.
	await page.fill('#edit-layer textarea', 'A settings');
	await page.click('button:has-text("Setup")');
	a = await db(page, 'a.txt');
	check(a.content === 'A settings', 'opening Settings flushes the pending edit', a.content);

	// A2: typing while a push or pull is on the network must survive it.
	const puts = [];
	await page.route('https://api.github.com/**', async route => {
		const req = route.request();
		const u = new URL(req.url());
		const json = (o) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(o), headers: { 'access-control-allow-origin': '*' } });
		if (u.pathname === '/repos/o/r/git/trees/main:') return json({ tree: [{ path: 'r.md', type: 'blob', sha: 's1', size: 2 }] });
		await new Promise(r => setTimeout(r, 1500));  // slow network: autosave fires mid-request
		if (req.method() === 'PUT') { puts.push(JSON.parse(req.postData())); return json({ content: { sha: 's2' } }); }
		return json({ content: b64('v1'), sha: 's1' });
	});
	await page.fill('.kc-token', 'tok');
	await page.fill('.tree-owner', 'o');
	await page.fill('.tree-repo', 'r');
	await commitInput(page);
	await page.click('button:has-text("Refresh List")');
	await page.waitForTimeout(300);
	await clickFile(page, 'r.md');
	await page.waitForTimeout(200);

	await page.click('#pull-btn');
	await page.waitForTimeout(200);
	await page.fill('#edit-layer textarea', 'typed during pull');
	page.dialogs.push('i');                         // conflict prompt: keep local
	await page.waitForTimeout(2000);
	let r = await db(page, 'r.md');
	check(r.content === 'typed during pull' && r.is_dirty && r.last_synced_sha === 's1', 'type during pull: edit kept, note stays dirty', r);
	check(await page.inputValue('#edit-layer textarea') === 'typed during pull', 'type during pull: editor keeps the edit');

	await page.fill('#edit-layer textarea', 'v1');
	await page.waitForTimeout(700);
	await page.keyboard.press('Control+s');
	await page.waitForTimeout(200);
	await page.fill('#edit-layer textarea', 'v1 v2');
	await page.waitForTimeout(2000);
	r = await db(page, 'r.md');
	check(puts.length === 1 && Buffer.from(puts[0].content, 'base64').toString() === 'v1', 'type during push: the pushed text is the text at Ctrl+S', puts);
	check(r.content === 'v1 v2' && r.is_dirty && r.last_synced_sha === 's2', 'type during push: edit kept, note stays dirty with the new sha', r);
	check(await page.inputValue('#edit-layer textarea') === 'v1 v2', 'type during push: editor keeps the edit');

	check(page.errors.length === 0, 'no page errors', page.errors);
	await page.context().close();
}

// B1 + B3 with a real service worker. The served sw.js on disk (DIST_DIR,
// default ../../dist) is rewritten during the test and restored afterwards:
// its CDN entries are dropped, since routes can't serve a worker's own
// requests, and a second build is simulated by changing its cache name.
// Skipped when that file is missing.
async function serviceWorkerUpdate(browser) {
	console.log('service worker');
	const swFile = path.join(process.env.DIST_DIR || path.join(__dirname, '..', '..', 'dist'), 'sw.js');
	if (!APP_URL.startsWith('http') || !fs.existsSync(swFile)) return console.log(`  skip (needs http and ${swFile})`);
	const original = fs.readFileSync(swFile, 'utf8');
	let served = 0;
	const serve = (text) => {
		fs.writeFileSync(swFile, text.replace(/^\s*'https:\/\/[^\n]*\n/gm, ''));
		// Servers like python's http.server compare whole seconds and would
		// answer the update check with 304.
		const mtime = new Date(Date.now() + 10000 * ++served);
		fs.utimesSync(swFile, mtime, mtime);
	};

	const ctx = await browser.newContext({ serviceWorkers: 'allow' });
	try {
		serve(original);
		const page = await ctx.newPage();
		const cacheNames = () => page.evaluate(() => caches.keys());
		const offerText = () => page.evaluate(() => {
			const bar = document.getElementById('status-bar');
			return bar.className === 'offer' && bar.style.display !== 'none' ? bar.textContent : '';
		});

		await page.goto(APP_URL);
		await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 10000 }).catch(() => {});
		await page.evaluate(() => { window.firstLoad = true; });
		await page.waitForTimeout(300);
		const id = await page.evaluate(() => define.require('buildInfo').id);
		check(JSON.stringify(await cacheNames()) === JSON.stringify([`notes-cache-${id}`]), 'cache is named after the build', await cacheNames());
		check(await page.evaluate(() => window.firstLoad === true) && await offerText() === '', 'first install neither reloads nor offers an update');

		serve(original.replace(/(const CACHE_NAME = CACHE_PREFIX \+ ')[^']+/, '$1next-build'));
		await page.evaluate(() => navigator.serviceWorker.getRegistration().then(r => r.update()));
		await page.waitForFunction(() => document.getElementById('status-bar').className === 'offer', null, { timeout: 10000 }).catch(() => {});
		check((await offerText()).startsWith('New version available'), 'new build waiting: status bar offers a reload', await offerText());
		check((await cacheNames()).includes('notes-cache-next-build'), 'new build gets a new cache name', await cacheNames());
		await page.click('#status-bar button:has-text("Reload")', { timeout: 2000 }).catch(() => {});
		await page.waitForFunction(() => !window.firstLoad, null, { timeout: 5000 }).catch(() => {});
		await page.waitForTimeout(500);
		check(await page.evaluate(() => !window.firstLoad), 'Reload reloads the page');
		check(JSON.stringify(await cacheNames()) === JSON.stringify(['notes-cache-next-build']), 'old cache deleted on activate', await cacheNames());
		check(await offerText() === '', 'no offer after reloading into the new build');
	} finally {
		fs.writeFileSync(swFile, original);
		await ctx.close();
	}
}

// Touch layouts (D10): an iPad is wider than the phone breakpoint, so it gets
// the side-by-side layout, but it has no hover to find the 6px strip.
// D12: rendered Markdown is a centred column of at most 48rem; wide blocks scroll inside it.
async function markdownWidth(browser) {
	console.log('markdown width');
	const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="3000" height="10"/>').toString('base64');
	const cols = Array.from({ length: 30 }, (_, i) => `column${i}`);
	const note = `# Wide\n\n${'word '.repeat(300)}\n\n| ${cols.join(' | ')} |\n|${' --- |'.repeat(30)}\n| ${cols.join(' | ')} |\n\n![w](data:image/svg+xml;base64,${svg})\n`;
	for (const [label, viewport] of [['wide screen', { width: 1600, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
		const ctx = await browser.newContext({ viewport, serviceWorkers: 'block' });
		const page = await newApp(browser, { context: ctx });
		await open(page);
		await createFile(page, 'wide.md', note);
		if (await page.textContent('#view-toggle') !== '✏️') await page.click('#view-toggle');
		await page.waitForSelector('.md-view h1', { timeout: 5000 }).catch(() => {});
		const m = await page.evaluate(() => {
			const layer = document.getElementById('view-layer'), a = layer.querySelector('.md-view');
			const lr = layer.getBoundingClientRect(), ar = a.getBoundingClientRect(), pad = parseFloat(getComputedStyle(layer).paddingLeft) + parseFloat(getComputedStyle(layer).paddingRight);
			const t = a.querySelector('table'), img = a.querySelector('img');
			return { article: ar.width, room: layer.clientWidth - pad, left: ar.left - lr.left, right: lr.right - ar.right,
				pageScrolls: layer.scrollWidth > layer.clientWidth, tableScrolls: t.scrollWidth > t.clientWidth, img: img.getBoundingClientRect().width };
		});
		if (label === 'wide screen') {
			check(m.article === 768 && Math.abs(m.left - m.right) < 2, `${label}: the column is 48rem and centred`, m);
		} else {
			check(Math.abs(m.article - m.room) < 1, `${label}: the column fills the width`, m);
		}
		check(!m.pageScrolls && m.tableScrolls && m.img <= m.article, `${label}: a wide table scrolls inside the column and a wide image fits`, m);
		await ctx.close();
	}
}

async function touchLayout(browser) {
	console.log('touch layout');
	const overflow = (page) => page.evaluate(() => {
		const sp = document.getElementById('settings-panel');
		const right = sp.getBoundingClientRect().right;
		return [...sp.querySelectorAll('input, select, button, label')]
			.filter(e => e.offsetParent && e.getBoundingClientRect().right > right + 1)
			.map(e => e.className || e.tagName);
	});
	const collapsed = (page) => page.evaluate(() => document.getElementById('sidebar').classList.contains('collapsed'));
	for (const [label, viewport, touch] of [['iPad portrait', { width: 820, height: 1180 }, true], ['phone', { width: 390, height: 844 }, true], ['desktop', { width: 1280, height: 800 }, false]]) {
		const ctx = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch, serviceWorkers: 'block' });
		const page = await newApp(browser, { context: ctx });
		await open(page);
		const width = await page.$eval('#toggle-sidebar', e => e.getBoundingClientRect().width);
		check(width === (touch ? 20 : 6), `${label}: strip is ${touch ? 'finger-wide' : 'thin'}`, width);
		if (touch) await page.tap('#toggle-sidebar'); else await page.click('#toggle-sidebar');
		check(await collapsed(page), `${label}: the strip collapses the sidebar`);
		if (touch) await page.tap('#toggle-sidebar'); else await page.click('#toggle-sidebar');
		check(!(await collapsed(page)), `${label}: the strip opens it again`);
		await page.click('button:has-text("Setup")');
		await page.evaluate(() => document.querySelectorAll('.tree-host').forEach(e => e.style.width = '320px'));  // as for remoteStorage
		check((await overflow(page)).length === 0, `${label}: nothing in Settings sticks out of the panel`, await overflow(page));
		await ctx.close();
	}
}

const builtIn = async (browser, name) => {
	const page = await browser.newPage();
	await page.goto(APP_URL);
	const found = await page.evaluate(n => define.names().includes(n) && define.require('plugins/registry').plugins.includes(define.require(n)), name);
	await page.close();
	return found;
};

(async () => {
	const browser = await chromium.launch();
	try {
		await basics(browser);
		await pasteCheck(browser);
		if (await builtIn(browser, 'plugins/panel')) {
			await panelForm(browser);
			await panelCommandsAndStatus(browser);
		} else {
			console.log('panel: SKIPPED, not built in (make PLUGINS="image pdf markdown panel text")');
		}
		await markdownImages(browser);
		const markers = await settingsAndGithub(browser);
		await dropbox(browser);
		await remoteStorage(browser);
		await crossTab(browser);
		await editRaces(browser);
		await markdownWidth(browser);
		await touchLayout(browser);
		await serviceWorkerUpdate(browser);
		if (process.env.PRINT_MARKERS) console.log(JSON.stringify(markers));
	} finally {
		await browser.close();
	}
	console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed');
	process.exit(failures ? 1 : 0);
})();
