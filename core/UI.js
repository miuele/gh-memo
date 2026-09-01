const UI = {
	_statusTimerId: null,

	toggleSidebar() {
		DOM.sidebar.classList.toggle('collapsed');
	},
	showStatus(text, isError = false) {
		// Cancel any in-flight auto-hide so a rapid second call cannot
		// cause the previous timer to dismiss the new message early.
		clearTimeout(this._statusTimerId);
		DOM.statusBar.textContent = text;
		DOM.statusBar.style.display = 'flex';
		DOM.statusBar.className = isError ? 'error' : '';
		if (!isError) {
			this._statusTimerId = setTimeout(() => DOM.statusBar.style.display = 'none', 4000);
		}
	},
	setLayerVisible(layer, isVisible) {
		layer.style.display = 'block';
		layer.style.visibility = isVisible ? 'visible' : 'hidden';
		layer.style.opacity = isVisible ? '1' : '0';
		layer.style.pointerEvents = isVisible ? 'auto' : 'none';
	},
	renderPins() {
		DOM.pinContainer.replaceChildren();
		const pins = AppState.activePins; // Read from the Forest level
		
		pins.forEach(pin => {
			DOM.pinContainer.appendChild(
				h('span', { class: 'pin-tag', onclick: () => Actions.handlePinClick(pin) },
					h('span', {}, pin),
					h('span', { class: 'pin-rm', onclick: e => Actions.removePin(pin, e) }, '\u00D7'),
				)
			);
		});
	},
	// Toggles the editor chrome buttons (save/pull/push/delete) as a unit.
	// Both resetEditor and setEditorActive maintain this set — a helper
	// ensures they stay in sync with no risk of one growing out of step.
	_setEditorChrome(isOpen) {
		const display = isOpen ? 'block' : 'none';
		DOM.saveBtn.style.display = display;
		DOM.pullBtn.style.display = display;
		DOM.pushBtn.style.display = display;
		DOM.deleteBtn.style.display = display;
	},
	resetEditor() {
		AppState.isViewMode = false;
		AppState.currentFilename = null;
		document.title = 'gh-memo';

		// 1. Unmount any active plugin to free memory
		if (AppState.activePlugin && AppState.activePlugin.unmount) {
			AppState.activePlugin.unmount();
			AppState.activePlugin = null;
		}

		// 2. Clear and reset the new agnostic layers
		DOM.editLayer.replaceChildren();
		DOM.viewLayer.replaceChildren();
		this.setLayerVisible(DOM.editLayer, false);
		this.setLayerVisible(DOM.viewLayer, false);

		DOM.filenameLabel.textContent = 'No file selected';
		this._setEditorChrome(false);
		DOM.statusBar.style.display = 'none';
		DOM.viewToggle.style.display = 'none';
		if (DOM.settingsPanel) DOM.settingsPanel.style.display = 'none';
	},
	async setEditorActive(filename, content) {
		AppState.currentFilename = filename;
		DOM.filenameLabel.textContent = filename;
		document.title = filename;
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
			AppState.activePlugin = null;
		}

		// 2. NEGOTIATE & INSTANTIATE
		const pluginHandler = PluginRegistry.find(p => p.canHandle(filename));
		const plugin = pluginHandler.create();
		// Note: activePlugin is set AFTER a successful mount. If mount() throws, the
		// previous plugin has already been unmounted but we avoid leaving activePlugin
		// pointing to a half-initialised instance.

		if (!plugin.supportedModes.includes('edit') && !AppState.isViewMode) AppState.isViewMode = true;
		else if (!plugin.supportedModes.includes('view') && AppState.isViewMode) AppState.isViewMode = false;

		// 3. PREPARE CHROME
		this._setEditorChrome(true);
		DOM.viewLayer.replaceChildren();
		DOM.editLayer.replaceChildren();

		// 4. PROVIDE SAVE HOOK
		const saveCallback = (newContent) => Actions.handleTyping(newContent);

		// 5. MOUNT
		await plugin.mount(filename, content, DOM.viewLayer, DOM.editLayer, saveCallback);
		AppState.activePlugin = plugin;

		this.applyModeVisibility();

		// On mobile the sidebar is a full-screen overlay. Close it automatically
		// when a file is opened so the editor is immediately visible without a
		// manual tap on the toggle strip.
		if (window.innerWidth <= 768 && !DOM.sidebar.classList.contains('collapsed')) {
			this.toggleSidebar();
		}
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
			this.setLayerVisible(DOM.editLayer, false);
			this.setLayerVisible(DOM.viewLayer, true);
		} else {
			this.setLayerVisible(DOM.editLayer, true);
			this.setLayerVisible(DOM.viewLayer, false);
		}
	},
	// Derives the status icon for a file-list entry purely from its note state.
	// Kept separate from the DOM construction loop so each concern has a single home.
	_getFileIcon(note) {
		const isDirty = note.is_dirty;
		const hasRemoteUpdate = note.remote_sha && note.remote_sha !== note.last_synced_sha;
		if (note.is_folder) return note.is_mount_point ? '🗂️' : '📁';
		if (note.filename.endsWith('.symlink')) return isDirty ? '🔗🟡' : '🔗';
		if (isDirty && hasRemoteUpdate) return '🟡⬇️';
		if (isDirty) return '🟡';
		if (hasRemoteUpdate) return '⬇️';
		return '🟢';
	},
	// Appends a trailing slash to folder entries so the type is visually unambiguous.
	_getDisplayName(note) {
		return note.is_folder ? note.filename + '/' : note.filename;
	},
	async renderFileList(searchTerm = '', deepSearch = false) {
		// 1. Grab a ticket for this specific render request
		const currentRenderId = ++AppState.renderId;

		let notes = await DBService.getAll();

		// --- VIRTUAL MOUNT POINT INJECTION ---
		const virtualMounts = VFS.getVirtualMounts();
		virtualMounts.forEach(relativePath => {
			if (!notes.find(n => n.filename === relativePath)) {
				notes.push({ filename: relativePath, is_folder: true, is_mount_point: true, is_dirty: false, matchCount: 0 });
			} else {
				notes.find(n => n.filename === relativePath).is_mount_point = true;
			}
		});
		// -------------------------------------

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

		// --- PARENT WORKSPACE NAVIGATION BUTTON ---
		// Only show the "Go Up" button if we are not currently searching
		if (!term) {
			const parentId = VFS.getParentWorkspace();
			if (parentId) {
				const li = h('li', {
					class: 'file-item parent-nav',
					onclick: () => Actions.switchWorkspace(parentId)
				}, h('span', {}, '🔙 ../'));

				DOM.fileList.appendChild(li);
			}
		}
		// ------------------------------------------

		notes.forEach(note => {
			const li = h('li', {
				class: 'file-item' + (note.filename === AppState.currentFilename ? ' active' : ''),
				onclick: () => Actions.openFile(note.filename)
			}, h('span', {}, this._getFileIcon(note) + ' ' + this._getDisplayName(note)));

			if (deepSearch && note.matchCount) {
				li.appendChild(h('span', { class: 'match-count' }, note.matchCount + ' match' + (note.matchCount > 1 ? 'es' : '')));
			}

			DOM.fileList.appendChild(li);
		});
	},

	renderSettings() {
		DOM.settingsPanel.replaceChildren();

		// ==========================================
		// 0: GLOBAL OVERRIDES
		// ==========================================
		DOM.settingsPanel.appendChild(
			h('div', { class: 'settings-header', style: 'margin-bottom: 20px; padding-bottom: 15px; border-bottom: 1px solid var(--border);' },
				h('label', { class: 'symlink-mode-label' },
					h('input', { 
					    type: 'checkbox', 
					    ...(AppState.isSymlinkEditMode ? { checked: true } : {}),
					    onchange: e => AppState.isSymlinkEditMode = e.target.checked
					}),
					'Symlink Edit Mode (Resets on reload)'
				)
			)
		);

		// ==========================================
		// 1: KEYCHAINS (CREDENTIALS)
		// ==========================================
		DOM.settingsPanel.appendChild(
			h('div', { class: 'settings-header' },
				h('h2', { style: 'margin: 0;' }, 'Keychains'),
				h('button', { onclick: () => Actions.createKeychain(), style: 'background: var(--accent); color: white; border: none;' }, '+ New Keychain')
			)
		);

		const kcTemplate = document.getElementById('keychain-card-template');
		for (const [id, kc] of Object.entries(AppState.keychains)) {
			DOM.settingsPanel.appendChild(this._createKeychainCard(id, kc, kcTemplate));
		}

		// ==========================================
		// 2: WORKSPACES (THE FOREST)
		// ==========================================
		DOM.settingsPanel.appendChild(
			h('div', { class: 'settings-header', style: 'margin-top: 40px;' },
				h('h2', { style: 'margin: 0;' }, 'Workspaces'),
				h('button', { onclick: () => Actions.createWorkspace(), style: 'background: var(--accent); color: white; border: none;' }, '+ New Origin Tree')
			)
		);

		const treeTemplate = document.getElementById('tree-group-template');
		const rowTemplate = document.getElementById('mount-row-template');

		for (const [sig, wsIds] of Object.entries(AppState.workspaceTrees)) {
			DOM.settingsPanel.appendChild(this._createTreeGroup(sig, wsIds, treeTemplate, rowTemplate));
		}

		// ==========================================
		// 3: GLOBAL SAVE
		// ==========================================
		DOM.settingsPanel.appendChild(
			h('button', { 
				class: 'settings-save-btn',
				onclick: () => Actions.saveSettings()
			}, '💾 Save All Configurations')
		);
	},

	// =====================================================================
	// UI SETTINGS HELPERS
	// =====================================================================

	_createKeychainCard(id, kc, template) {
		const clone = template.content.cloneNode(true);
		const card = clone.querySelector('.profile-card');

		card.querySelector('.kc-title').textContent = kc.name;

		const providerEl = card.querySelector('.kc-provider');
		const tokenEl = card.querySelector('.kc-token');
		const appKeyEl = card.querySelector('.kc-appkey');

		providerEl.value = kc.provider || 'github';
		tokenEl.value = kc.token || '';
		appKeyEl.value = kc.appKey || '';

		providerEl.addEventListener('change', e => kc.provider = e.target.value);
		tokenEl.addEventListener('input', e => kc.token = e.target.value);
		appKeyEl.addEventListener('input', e => kc.appKey = e.target.value);

		const toggleVisibility = () => {
			const isDbx = providerEl.value === 'dropbox';
			card.querySelectorAll('.dbx-only').forEach(el => el.style.display = isDbx ? 'flex' : 'none');
			card.querySelectorAll('.gh-only').forEach(el => el.style.display = isDbx ? 'none' : 'flex');
		};
		providerEl.addEventListener('change', toggleVisibility);
		toggleVisibility();

		const dbxStatusEl = card.querySelector('.dbx-status');
		const btnLinkDbx = card.querySelector('.btn-link-dbx');
		
		if (dbxStatusEl) {
			dbxStatusEl.textContent = kc.refreshToken ? '✅ Linked (Auto-refresh active)' : '❌ Not linked';
			dbxStatusEl.style.color = kc.refreshToken ? 'var(--success, green)' : 'var(--danger, red)';
		}
		
		if (btnLinkDbx) {
			btnLinkDbx.style.display = kc.refreshToken ? 'none' : 'block';
			btnLinkDbx.addEventListener('click', () => {
				Actions.saveSettings(); 
				Actions.linkDropboxPKCE(id);
			});
		}
		
		appKeyEl.addEventListener('input', () => {
			if (btnLinkDbx && kc.refreshToken) {
				dbxStatusEl.textContent = '⚠️ App Key changed. Re-link required.';
				dbxStatusEl.style.color = '#c98200';
				btnLinkDbx.style.display = 'block';
			}
		});

		card.querySelector('.btn-delete').addEventListener('click', () => Actions.deleteKeychain(id));
		return card;
	},

	_createTreeGroup(sig, wsIds, treeTemplate, rowTemplate) {
		const refWs = AppState.workspaces[wsIds[0]];
		const refKc = AppState.keychains[refWs.keychainId];

		const clone = treeTemplate.content.cloneNode(true);
		const groupEl = clone.querySelector('.tree-group');
		const listEl = groupEl.querySelector('.mount-list');
		const titleEl = groupEl.querySelector('.tree-title');

		// Set dynamic title
		if (sig.startsWith('github|')) {
		    titleEl.textContent = `🐙 ${refWs.owner || '(No Owner)'} / ${refWs.repo || '(No Repo)'}`;
		} else {
		    titleEl.textContent = `🗄️ Dropbox Storage`;
		}

		// Bind Shared Inputs
		const selectKc = groupEl.querySelector('.tree-keychain');
		const ownerEl = groupEl.querySelector('.tree-owner');
		const repoEl = groupEl.querySelector('.tree-repo');
		const branchEl = groupEl.querySelector('.tree-branch');
		const hostEl = groupEl.querySelector('.tree-host');
		const commitToggle = groupEl.querySelector('.tree-askCommit');
		const ghContainer = groupEl.querySelector('.tree-gh-only');

		// Populate Keychains Dropdown
		for (const [kcId, keychain] of Object.entries(AppState.keychains)) {
			selectKc.appendChild(h('option', { value: kcId }, `${keychain.name} (${keychain.provider})`));
		}
		selectKc.value = refWs.keychainId || '';

		// Visibility Toggle for Dropbox
		const toggleGhVisibility = () => {
			const selectedKcId = selectKc.value;
			const provider = selectedKcId && AppState.keychains[selectedKcId] 
				? AppState.keychains[selectedKcId].provider : 'github';
			ghContainer.style.display = (provider === 'dropbox') ? 'none' : 'flex';
		};
		toggleGhVisibility();

		// Setup Values
		ownerEl.value = refWs.owner || '';
		repoEl.value = refWs.repo || '';
		branchEl.value = refWs.branch || '';
		hostEl.value = refWs.host || '';
		commitToggle.checked = !!refWs.askForCommitMsg;

		// Bind Events (Propagate changes to ALL workspaces in this tree instantly)
		// updateTreeTitle is extracted because both ownerEl and repoEl need the same
		// template — inlining it in each handler caused the string to diverge over time.
		const updateTreeTitle = () => {
			titleEl.textContent = `🐙 ${ownerEl.value || '(No Owner)'} / ${repoEl.value || '(No Repo)'}`;
		};
		selectKc.addEventListener('change', e => {
			wsIds.forEach(id => AppState.workspaces[id].keychainId = e.target.value);
			toggleGhVisibility();
		});
		ownerEl.addEventListener('input', e => {
			wsIds.forEach(id => AppState.workspaces[id].owner = e.target.value);
			updateTreeTitle();
		});
		repoEl.addEventListener('input', e => {
			wsIds.forEach(id => AppState.workspaces[id].repo = e.target.value);
			updateTreeTitle();
		});
		branchEl.addEventListener('input', e => wsIds.forEach(id => AppState.workspaces[id].branch = e.target.value));
		hostEl.addEventListener('input', e => wsIds.forEach(id => AppState.workspaces[id].host = e.target.value));
		commitToggle.addEventListener('change', e => wsIds.forEach(id => AppState.workspaces[id].askForCommitMsg = e.target.checked));

		// Mount Point Spawner
		groupEl.querySelector('.btn-add-mount').addEventListener('click', () => Actions.createMountPoint(refWs));

		// Render the child rows
		for (const id of wsIds) {
			const ws = AppState.workspaces[id];
			const isActive = id === AppState.activeWorkspaceId;
			listEl.appendChild(this._createMountRow(id, ws, wsIds, isActive, rowTemplate));
		}

		return groupEl;
	},

	_createMountRow(id, ws, wsIds, isActive, rowTemplate) {
		const rowClone = rowTemplate.content.cloneNode(true);
		const rowEl = rowClone.querySelector('.mount-row');

		if (isActive) rowEl.classList.add('active');

		const nameEl = rowEl.querySelector('.ws-name');
		const rootEl = rowEl.querySelector('.ws-rootDir');
		const shallowEl = rowEl.querySelector('.ws-shallow');
		const warningEl = rowEl.querySelector('.leaf-warning');

		nameEl.value = ws.name;
		nameEl.addEventListener('input', e => ws.name = e.target.value);

		rootEl.value = ws.rootDir || '';
		rootEl.addEventListener('input', e => ws.rootDir = e.target.value);

		// Leaf Constraint Visualization
		const currentRoot = Utils.cleanPath(ws.rootDir);
		const hasChildren = wsIds.some(childId => {
			if (childId === id) return false;
			const childRoot = Utils.cleanPath(AppState.workspaces[childId].rootDir);
			return childRoot.startsWith(currentRoot ? currentRoot + '/' : '');
		});

		if (hasChildren) {
			shallowEl.checked = true;
			shallowEl.disabled = true;
			ws.shallow = true; 
			warningEl.style.display = 'inline';
		} else {
			shallowEl.checked = !!ws.shallow;
			shallowEl.addEventListener('change', e => ws.shallow = e.target.checked);
		}

		const btnSwitch = rowEl.querySelector('.btn-switch');
		if (isActive) {
			btnSwitch.textContent = 'Active';
			btnSwitch.disabled = true;
			btnSwitch.style.background = 'var(--accent)';
			btnSwitch.style.color = 'white';
		} else {
			btnSwitch.addEventListener('click', () => Actions.switchWorkspace(id));
		}

		rowEl.querySelector('.btn-clear').addEventListener('click', () => Actions.clearDB(id));
		rowEl.querySelector('.btn-delete').addEventListener('click', () => Actions.deleteWorkspace(id));

		return rowEl;
	},
	updateWorkspaceIndicator() {
		if (!DOM.workspaceIndicator) return;

		const ws = AppState.activeWorkspace;
		if (!ws) {
			DOM.workspaceIndicator.textContent = '';
			return;
		}

		DOM.workspaceIndicator.textContent = `📁 ${ws.name.toUpperCase()}`;

		// Build a rich hover tooltip
		const kc = AppState.keychains[ws.keychainId];
		const providerStr = kc ? kc.provider : 'unknown';

		if (providerStr === 'github') {
			DOM.workspaceIndicator.title = `Provider: GitHub\nRepo: ${ws.owner}/${ws.repo}\nBranch: ${ws.branch}\nRoot: ${ws.rootDir || '/'}`;
		} else {
			DOM.workspaceIndicator.title = `Provider: Dropbox\nRoot: ${ws.rootDir || '/'}`;
		}
	},
};
