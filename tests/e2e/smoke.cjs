// Optional end-to-end smoke test. Not part of `make test`: it needs Playwright.
//
//   make serve &                      # or any static server on dist/
//   node tests/e2e/smoke.cjs http://localhost:8000/index.html
//
// GitHub and Dropbox are mocked with page.route(), so no tokens or network
// access are needed. CDN libraries load from the real CDN unless CDN_DIR is
// set, in which case they are served from local copies (and SRI is bypassed,
// since local copies are not byte-identical to the CDN builds).
//
// Env: PLAYWRIGHT_PATH (where to require playwright from), CDN_DIR.

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
	check(page.url().endsWith('#a.txt'), 'hash reflects open file', page.url());
	check((await listText(page)).some(t => t.trim() === 'a.txt'), 'file list shows local-only file without icon', await listText(page));

	await createFile(page, 'notes', 'n');
	check(!!(await db(page, 'notes.txt')), 'extensionless name gets .txt');

	await createFile(page, 'm.md', '# Title\n\nInline $x^2$ and `code`.\n\n[to a](a.txt)\n\n![pic](pic.png)\n\n```js\nconst q = 1;\n```\n');
	await page.click('#view-toggle');
	await page.waitForSelector('#view-layer h1', { timeout: 5000 }).catch(() => {});
	check(await page.textContent('#view-layer h1').catch(() => null) === 'Title', 'markdown renders heading');
	check(await page.$('#view-layer .katex') !== null, 'markdown renders KaTeX');
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

async function settingsAndGithub(browser) {
	console.log('settings + github');
	const page = await newApp(browser);
	const requests = [];
	let remoteFile = { content: '# R', sha: 's1' };
	await page.route('https://api.github.com/**', async route => {
		const req = route.request();
		const u = new URL(req.url());
		requests.push({ method: req.method(), path: u.pathname + u.search, auth: req.headers()['authorization'], body: req.postData() });
		const json = (o, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(o), headers: { 'access-control-allow-origin': '*' } });
		if (u.pathname === '/repos/o/r/git/trees/main:docs' && req.method() === 'GET') return json({ tree: [{ path: 'x.txt', type: 'blob', sha: 'sx', size: 1 }] });
		if (u.pathname === '/repos/o/r/git/trees/main:' && req.method() === 'GET') {
			return json({ tree: [
				{ path: 'remote.md', type: 'blob', sha: remoteFile.sha, size: 3 },
				{ path: 'docs/x.txt', type: 'blob', sha: 'sx', size: 1 },
				{ path: 'docs', type: 'tree', sha: 'sd' },
			] });
		}
		if (u.pathname === '/repos/o/r/contents/remote.md' && req.method() === 'GET') return json({ content: b64(remoteFile.content), sha: remoteFile.sha });
		if (u.pathname === '/repos/o/r/contents/remote.md' && req.method() === 'PUT') return json({ content: { sha: 's3' } });
		if (u.pathname === '/repos/o/r/contents/remote.md' && req.method() === 'DELETE') return json({});
		if (u.pathname === '/repos/o/r/contents/' && req.method() === 'GET') return json([{ name: 'docs', sha: 'sd', type: 'dir' }, { name: 'top.md', sha: 'st', type: 'file', size: 1 }]);
		if (u.pathname === '/repos/o/r/contents/docs' && req.method() === 'GET') return json([{ name: 'x.txt', sha: 'sx', type: 'file', size: 1 }, { name: 'sub', sha: 'ss', type: 'dir' }]);
		return json({ message: 'not mocked' }, 404);
	});
	await open(page);

	await page.click('button:has-text("Setup")');
	check(await header(page) === 'Settings & Profiles', 'settings opens');
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
	await page.fill('.tree-owner', 'o');
	await page.fill('.tree-repo', 'r');
	check((await page.textContent('.tree-title')).includes('o / r'), 'tree title follows owner/repo');
	await page.click('button:has-text("Save All Configurations")');
	const ws = (await ls(page, 'notes_workspaces')).ws_default;
	check(ws.owner === 'o' && ws.repo === 'r' && (await ls(page, 'notes_keychains')).kc_default.token === 'tok', 'settings saved');

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

	// Commit message prompt
	await page.evaluate(() => {});
	await page.click('button:has-text("Setup")');
	await page.check('.tree-askCommit');
	await page.click('button:has-text("Save All Configurations")');
	await clickFile(page, 'remote.md');
	await page.waitForTimeout(200);
	await page.fill('#edit-layer textarea', '# R again');
	await page.waitForTimeout(700);
	page.dialogs.push('my message');
	await page.keyboard.press('Control+s');
	await page.waitForTimeout(400);
	const put2 = requests.filter(r => r.method === 'PUT')[1];
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
	check(n.is_dirty && n.content.includes('<<<<<<< LOCAL') && n.content.includes('>>>>>>> REMOTE'), 'conflict "d" inserts markers', n.content);
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
	await page.click('button:has-text("Save All Configurations")');
	const wss = await ls(page, 'notes_workspaces');
	const mountId = Object.keys(wss).find(id => wss[id].rootDir === 'docs');
	check(mountId && wss[mountId].name === 'Local Workspace (docs)' && wss.ws_default.shallow === true, 'mount persisted; parent forced shallow', wss);

	await page.click('button:has-text("Refresh List")');
	await page.waitForTimeout(300);
	check(requests.some(r => r.path === '/repos/o/r/contents/?ref=main'), 'shallow refresh uses contents API', requests.map(r => r.path));

	const rootList = await listText(page);
	check(rootList.some(t => t.includes('🗂️ docs/')) && rootList.includes('⬇️ top.md'), 'shallow listing; mount shows as folder', rootList);
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
	await page.goBack();
	await page.waitForTimeout(300);

	// Symlink
	await page.click('button:has-text("Setup")');
	await page.check('.symlink-mode-label input');
	await page.click('#file-list li:has-text("../")').catch(() => {});
	await page.waitForTimeout(300);
	await createFile(page, 'go.symlink', '{"rootDir": "docs"}');
	await page.click('button:has-text("Setup")');
	await page.uncheck('.symlink-mode-label input');
	await clickFile(page, 'go.symlink');
	await page.waitForTimeout(300);
	check((await page.textContent('#workspace-indicator')).includes('(DOCS)'), 'symlink switches workspace');

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
	await page.goto(APP_URL + '?code=CODE');
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

(async () => {
	const browser = await chromium.launch();
	try {
		await basics(browser);
		await pasteCheck(browser);
		const markers = await settingsAndGithub(browser);
		await dropbox(browser);
		await crossTab(browser);
		if (process.env.PRINT_MARKERS) console.log(JSON.stringify(markers));
	} finally {
		await browser.close();
	}
	console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed');
	process.exit(failures ? 1 : 0);
})();
