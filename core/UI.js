const UI = {
	toggleSidebar() {
		DOM.sidebar.classList.toggle('collapsed');
	},
	showStatus(text, isError = false) {
		DOM.statusBar.textContent = text;
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
					h('span', { class: 'pin-rm', onclick: e => Actions.removePin(pin, e) }, '\u00D7'),
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
			const isSymlink = note.filename.endsWith('.symlink');

			// Apply Symlink styling
			if (isSymlink) {
				icon = '🔗';
				if (isDirty) icon = '🔗🟡';
			} else {
				if (isDirty && hasRemoteUpdate) icon = '🟡⬇️'; 
				else if (isDirty) icon = '🟡';   
				else if (hasRemoteUpdate) icon = '⬇️';   
			}

			const li = h('li', {
				class: 'file-item' + (note.filename === AppState.currentFilename ? ' active' : ''),
				onclick: () => Actions.openFile(note.filename)
			}, h('span', {}, icon + ' ' + note.filename));

			if (deepSearch && note.matchCount) {
				li.appendChild(h('span', { class: 'match-count' }, note.matchCount + ' match' + (note.matchCount > 1 ? 'es' : '')));
			}

			DOM.fileList.appendChild(li);
		});
	},
	renderSettings() {
		// 1. Clear the panel
		DOM.settingsPanel.replaceChildren();

		// ==========================================
		// SECTION 0: GLOBAL OVERRIDES
		// ==========================================
		DOM.settingsPanel.appendChild(
		    h('div', { class: 'settings-header', style: 'margin-bottom: 20px; padding-bottom: 15px; border-bottom: 1px solid var(--border);' },
		        h('label', { style: 'display: flex; align-items: center; gap: 10px; cursor: pointer; color: #c98200; font-weight: bold;' },
		            h('input', { 
		                type: 'checkbox', 
		                checked: AppState.isSymlinkEditMode,
		                onchange: e => AppState.isSymlinkEditMode = e.target.checked
		            }),
		            '🔧 Enable Symlink Edit Mode (Resets on reload)'
		        )
		    )
		);

		// ==========================================
		// SECTION 1: KEYCHAINS (CREDENTIALS)
		// ==========================================
		DOM.settingsPanel.appendChild(
			h('div', { class: 'settings-header' },
				h('h2', { style: 'margin: 0;' }, '🔑 Keychains (Credentials)'),
				h('button', { 
					onclick: () => Actions.createKeychain(), 
					style: 'background: var(--accent); color: white; border: none;' 
				}, '+ New Keychain')
			)
		);

		const kcTemplate = document.getElementById('keychain-card-template');

		for (const [id, kc] of Object.entries(AppState.keychains)) {
			const clone = kcTemplate.content.cloneNode(true);
			const card = clone.querySelector('.profile-card');

			card.querySelector('.kc-title').textContent = kc.name;

			// Map inputs and bind live updates to AppState
			const providerEl = card.querySelector('.kc-provider');
			providerEl.value = kc.provider || 'github';
			providerEl.addEventListener('change', e => kc.provider = e.target.value);

			const tokenEl = card.querySelector('.kc-token');
			tokenEl.value = kc.token || '';
			tokenEl.addEventListener('input', e => kc.token = e.target.value);

			const appKeyEl = card.querySelector('.kc-appkey');
			appKeyEl.value = kc.appKey || '';
			appKeyEl.addEventListener('input', e => kc.appKey = e.target.value);

			// Visibility toggle logic
			const toggleVisibility = () => {
				const isDbx = providerEl.value === 'dropbox';
				card.querySelectorAll('.dbx-only').forEach(el => el.style.display = isDbx ? 'flex' : 'none');
				card.querySelectorAll('.gh-only').forEach(el => el.style.display = isDbx ? 'none' : 'flex');
			};
			providerEl.addEventListener('change', toggleVisibility);
			toggleVisibility();

			// --- DROPBOX UI LOGIC ---
			const dbxStatusEl = card.querySelector('.dbx-status');
			const btnLinkDbx = card.querySelector('.btn-link-dbx');
			
			if (dbxStatusEl) {
			    dbxStatusEl.textContent = kc.refreshToken ? '✅ Linked (Auto-refresh active)' : '❌ Not linked';
			    dbxStatusEl.style.color = kc.refreshToken ? 'var(--success, green)' : 'var(--danger, red)';
			}
			
			if (btnLinkDbx) {
			    // Only show the link button if it's NOT linked yet, or if they change the app key
			    btnLinkDbx.style.display = kc.refreshToken ? 'none' : 'block';
			    
			    btnLinkDbx.addEventListener('click', () => {
			        // Save state immediately before redirecting so the App Key isn't lost
			        Actions.saveSettings(); 
			        Actions.linkDropboxPKCE(id);
			    });
			}
			
			// Re-evaluate the link button visibility if the user edits the App Key
			appKeyEl.addEventListener('input', () => {
			    if (btnLinkDbx && kc.refreshToken) {
			        dbxStatusEl.textContent = '⚠️ App Key changed. Re-link required.';
			        dbxStatusEl.style.color = '#c98200'; // Warning orange
			        btnLinkDbx.style.display = 'block';
			    }
			});
			// ------------------------

			card.querySelector('.btn-delete').addEventListener('click', () => Actions.deleteKeychain(id));

			DOM.settingsPanel.appendChild(card);
		}

		// ==========================================
		// SECTION 2: WORKSPACES (MOUNT POINTS)
		// ==========================================
		DOM.settingsPanel.appendChild(
			h('div', { class: 'settings-header', style: 'margin-top: 40px;' },
				h('h2', { style: 'margin: 0;' }, '📁 Workspaces (Mount Points)'),
				h('button', { 
					onclick: () => Actions.createWorkspace(), 
					style: 'background: var(--accent); color: white; border: none;' 
				}, '+ New Workspace')
			)
		);

		const wsTemplate = document.getElementById('workspace-card-template');

		for (const [id, ws] of Object.entries(AppState.workspaces)) {
			const isActive = id === AppState.activeWorkspaceId;
			const clone = wsTemplate.content.cloneNode(true);
			const card = clone.querySelector('.profile-card');

			if (isActive) card.classList.add('active');

			// Build Title
			const titleEl = card.querySelector('.ws-title');
			titleEl.textContent = ws.name;
			if (isActive) {
				titleEl.appendChild(h('span', { style: 'color:var(--accent); font-size: 14px;' }, ' (Active)'));
			}

			// Populate Keychain Foreign Key Dropdown
			const selectKc = card.querySelector('.ws-keychain');
			for (const [kcId, keychain] of Object.entries(AppState.keychains)) {
			    selectKc.appendChild(h('option', { value: kcId }, `${keychain.name} (${keychain.provider})`));
			}
			selectKc.value = ws.keychainId || '';
			
			// --- WORKSPACE VISIBILITY TOGGLE ---
			const toggleWsVisibility = () => {
			    const selectedKcId = selectKc.value;
			    // Look up the provider of the linked keychain in AppState
			    const provider = selectedKcId && AppState.keychains[selectedKcId] 
			        ? AppState.keychains[selectedKcId].provider 
			        : 'github';
			        
			    const isDbx = provider === 'dropbox';
			    
			    // Hide GitHub fields if Dropbox is selected
			    card.querySelectorAll('.ws-gh-only').forEach(el => {
			        el.style.display = isDbx ? 'none' : 'flex';
			    });
			};
			
			// Listen for dropdown changes
			selectKc.addEventListener('change', e => {
			    ws.keychainId = e.target.value;
			    toggleWsVisibility();
			});
			
			// Run once on initial render
			toggleWsVisibility();
			// -----------------------------------

			// Map String Inputs
			const fields = ['host', 'owner', 'repo', 'branch', 'rootDir'];
			fields.forEach(f => {
				const el = card.querySelector(`.ws-${f}`);
				el.value = ws[f] || (f === 'branch' ? 'main' : (f === 'host' ? 'https://api.github.com' : ''));
				el.addEventListener('input', e => ws[f] = e.target.value);
			});

			// Map Boolean Checkbox
			const shallowEl = card.querySelector('.ws-shallow');
			shallowEl.checked = !!ws.shallow;
			shallowEl.addEventListener('change', e => ws.shallow = e.target.checked);

			// Event Listeners
			const btnSwitch = card.querySelector('.btn-switch');
			if (isActive) btnSwitch.remove();
			else btnSwitch.addEventListener('click', () => Actions.switchWorkspace(id));

			card.querySelector('.btn-clear').addEventListener('click', () => Actions.clearDB(id));
			card.querySelector('.btn-delete').addEventListener('click', () => Actions.deleteWorkspace(id));

			DOM.settingsPanel.appendChild(card);
		}

		// ==========================================
		// SECTION 3: GLOBAL SAVE
		// ==========================================
		DOM.settingsPanel.appendChild(
			h('button', { 
				onclick: () => Actions.saveSettings(),
				style: 'margin-top: 20px; width: 100%; padding: 12px; background: var(--accent); color: white; border: none; font-size: 16px; font-weight: bold; border-radius: 6px;'
			}, '💾 Save All Configurations')
		);
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
