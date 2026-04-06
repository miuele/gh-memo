const UI = {
	toggleSidebar() {
		DOM.sidebar.classList.toggle('collapsed');
	},
	showStatus(html, isError = false) {
		if (html instanceof Node) {
			DOM.statusBar.appendChild(html);
		} else {
			DOM.statusBar.textContent = String(html);
		}
		DOM.statusBar.style.display = 'flex';
		DOM.statusBar.className = isError ? 'error' : '';
		if (!isError) setTimeout(() => DOM.statusBar.style.display = 'none', 4000);
	},
	renderPins() {
		DOM.pinContainer.replaceChildren();
		AppState.pins.forEach(pin => {
			DOM.pinContainer.appendChild(
				h('span', { class: 'pin-tag', onclick: () => Actions.handlePinClick(pin) },
					h('span', {}, pin),
					h('span', { class: 'pin-rm', onclick: e => Actions.removePin(pin, e) }, '&times;'),
				)
			);
		});
	},
	resetEditor() {
		AppState.isViewMode = false;
		AppState.currentFilename = null;

		// 1. Unmount any active plugin to free memory
		if (AppState.activePlugin && AppState.activePlugin.unmount) {
			AppState.activePlugin.unmount();
			AppState.activePlugin = null;
		}

		// 2. Clear and reset the new agnostic layers
		DOM.editLayer.replaceChildren();
		DOM.viewLayer.replaceChildren();
		DOM.editLayer.style.display = 'block';
		DOM.viewLayer.style.display = 'none';

		DOM.filenameLabel.textContent = 'No file selected';
		DOM.deleteBtn.style.display = 'none';
		DOM.pullBtn.style.display = 'none';
		DOM.pushBtn.style.display = 'none';
		DOM.statusBar.style.display = 'none';
		DOM.viewToggle.style.display = 'none';
		if (DOM.settingsPanel) DOM.settingsPanel.style.display = 'none';
	},
	async setEditorActive(filename, content) {
		AppState.currentFilename = filename;
		DOM.filenameLabel.textContent = filename;
		DOM.statusBar.style.display = 'none';

		// Reset any previous cross-tab freezes
		AppState.isFrozen = false;
		DOM.pullBtn.disabled = false;
		DOM.pushBtn.disabled = false;
		DOM.editLayer.style.opacity = '1';
		DOM.editLayer.style.pointerEvents = 'auto';

		if (DOM.settingsPanel) DOM.settingsPanel.style.display = 'none';

		// 1. UNMOUNT
		if (AppState.activePlugin && AppState.activePlugin.unmount) {
			AppState.activePlugin.unmount();
		}

		// 2. NEGOTIATE & INSTANTIATE
		const pluginHandler = PluginRegistry.find(p => p.canHandle(filename));
		const plugin = pluginHandler.create();
		AppState.activePlugin = plugin;

		if (!plugin.supportedModes.includes('edit') && !AppState.isViewMode) AppState.isViewMode = true;
		else if (!plugin.supportedModes.includes('view') && AppState.isViewMode) AppState.isViewMode = false;

		// 3. PREPARE CHROME
		DOM.pullBtn.style.display = 'block';
		DOM.pushBtn.style.display = 'block';
		DOM.deleteBtn.style.display = 'block';
		DOM.viewLayer.replaceChildren();
		DOM.editLayer.replaceChildren();

		// 4. PROVIDE SAVE HOOK
		const saveCallback = (newContent) => Actions.handleTyping(newContent);

		// 5. MOUNT
		await plugin.mount(filename, content, DOM.viewLayer, DOM.editLayer, saveCallback);

		this.applyModeVisibility();
	},

	applyModeVisibility() {
		const plugin = AppState.activePlugin;

		if (plugin.supportedModes.includes('view') && plugin.supportedModes.includes('edit')) {
			DOM.viewToggle.style.display = 'flex';
			DOM.viewToggle.textContent = AppState.isViewMode ? '✏️' : '👁️';
		} else {
			DOM.viewToggle.style.display = 'none';
		}

		if (AppState.isViewMode) {
			DOM.editLayer.style.display = 'none';
			DOM.viewLayer.style.display = 'block';
		} else {
			DOM.viewLayer.style.display = 'none';
			DOM.editLayer.style.display = 'block';
		}
	},
	async renderFileList(searchTerm = '', deepSearch = false) {
		// 1. Grab a ticket for this specific render request
		const currentRenderId = ++AppState.renderId;

		let notes = await DBService.getAll();

		// 2. If another search started while we were waiting for the DB, abort this one!
		if (currentRenderId !== AppState.renderId) return;

		DOM.fileList.replaceChildren();
		const term = searchTerm.toLowerCase();

		if (term) {
			if (deepSearch) {
				notes.forEach(note => {
					// Guard against binary blobs
					if (typeof note.content === 'string') {
						const content = note.content.toLowerCase();
						note.matchCount = content.split(term).length - 1;
					} else {
						note.matchCount = 0;
					}
				});
				notes = notes.filter(n => n.matchCount > 0 || n.filename.toLowerCase().includes(term));
				notes.sort((a, b) => (b.matchCount || 0) - (a.matchCount || 0));
			} else {
				notes = notes.filter(n => n.filename.toLowerCase().includes(term));
			}
		} else {
			notes.sort((a, b) => a.filename.localeCompare(b.filename));
		}

		notes.forEach(note => {
			let icon = '🟢'; 
			const isDirty = note.is_dirty;
			const hasRemoteUpdate = note.remote_sha && note.remote_sha !== note.last_synced_sha;

			if (isDirty && hasRemoteUpdate) icon = '🟡⬇️'; 
			else if (isDirty) icon = '🟡';   
			else if (hasRemoteUpdate) icon = '⬇️';   

			const li = h('li', {
				class: 'file-item' + (note.filename === AppState.currentFilename ? ' active' : ''),
				onclick: () => Actions.openFile(note.filename)
			}, h('span', {}, icon + ' ' + note.filename));

			if (deepSearch && note.matchCount) {
				li.appendChild(h('span', { class: 'match-count' }, note.matchCount + ' match' + note.matchCount > 1 ? 'es' : ''));
			}

			DOM.fileList.appendChild(li);
		});
	},
	renderSettings() {
		// 1. Clear panel and build header securely
		DOM.settingsPanel.replaceChildren(
			h('div', { class: 'settings-header' },
				h('h2', {}, '⚙️ Profiles & Settings'),
				h('button', { 
					onclick: () => Actions.createProfile(), 
					style: 'background: var(--accent); color: white; border: none;' 
				}, '+ New Profile')
			)
		);

		const template = document.getElementById('profile-card-template');

		for (const [id, profile] of Object.entries(AppState.profiles)) {
			const isActive = id === AppState.activeProfileId;
			const c = profile.config;

			const clone = template.content.cloneNode(true);
			const card = clone.querySelector('.profile-card');

			if (isActive) card.classList.add('active');

			// 2. Build the title
			const titleEl = card.querySelector('.profile-title');
			titleEl.textContent = profile.name;
			if (isActive) {
				titleEl.appendChild(h('span', { style: 'color:var(--accent); font-size: 14px;' }, ' (Active)'));
			}

			// 3. Map generic inputs and apply dynamic IDs
			const fields = ['provider', 'token', 'host', 'owner', 'repo', 'branch'];
			fields.forEach(f => {
				const el = card.querySelector(`.cfg-${f}`);
				el.id = `cfg-${f}-${id}`;
				el.value = c[f] || (f === 'provider' ? 'github' : (f === 'branch' ? 'main' : ''));
			});

			// 4. Handle Dropbox-specific fields securely
			const dbxKeyEl = card.querySelector('.cfg-dbx-key');
			dbxKeyEl.id = `cfg-dbx-key-${id}`;
			dbxKeyEl.value = c.appKey || '';
			card.querySelector('.dbx-status').textContent = `Status: ${c.refreshToken ? '✅ Linked (Auto-refresh active)' : '❌ Not linked'}`;

			// 5. Visibility toggle logic
			const toggleVisibility = () => {
				const isDbx = card.querySelector('.cfg-provider').value === 'dropbox';
				card.querySelectorAll('.dbx-only').forEach(el => el.style.display = isDbx ? 'flex' : 'none');
				card.querySelectorAll('.gh-only').forEach(el => el.style.display = isDbx ? 'none' : 'flex');
			};
			card.querySelector('.cfg-provider').addEventListener('change', toggleVisibility);
			toggleVisibility();

			// 6. Event listener binding
			const btnSwitch = card.querySelector('.btn-switch');
			if (isActive) btnSwitch.remove();
			else btnSwitch.addEventListener('click', () => { Actions.switchProfile(id); UI.renderSettings(); });

			card.querySelector('.btn-clear').addEventListener('click', () => Actions.clearDB(id));
			card.querySelector('.btn-delete').addEventListener('click', () => Actions.deleteProfile(id));
			card.querySelector('.btn-link-dbx').addEventListener('click', () => Actions.linkDropboxPKCE(id));
			card.querySelector('.btn-save').addEventListener('click', () => Actions.updateProfileConfig(id));

			DOM.settingsPanel.appendChild(card);
		}
	},
	toggleProviderFields(id) {
		const provider = document.getElementById(`cfg-provider-${id}`).value;
		const dbxFields = document.querySelectorAll(`.dbx-only-${id}`);
		const ghFields = document.querySelectorAll(`.gh-only-${id}`);
		if (provider === 'dropbox') {
			dbxFields.forEach(el => el.style.display = 'flex');
			ghFields.forEach(el => el.style.display = 'none');
		} else {
			dbxFields.forEach(el => el.style.display = 'none');
			ghFields.forEach(el => el.style.display = 'flex');
		}
	},
};
