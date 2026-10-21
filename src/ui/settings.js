// The settings screen: keychains (credentials) and the workspace forest
// (one group per origin tree, one row per mount point). Inputs edit the
// in-memory config directly; handlers.save() persists it.
define('ui/settings', ['ui/refs', 'lib/dom', 'lib/path', 'model/config', 'model/forest', 'buildInfo'], (DOM, Dom, Path, Config, Forest, BuildInfo) => {
	const { h } = Dom;
	let handlers = {};

	const createKeychainCard = (id, kc, template) => {
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
				handlers.save();
				handlers.linkDropbox(id);
			});
		}

		appKeyEl.addEventListener('input', () => {
			if (btnLinkDbx && kc.refreshToken) {
				dbxStatusEl.textContent = '⚠️ App Key changed. Re-link required.';
				dbxStatusEl.style.color = '#c98200';
				btnLinkDbx.style.display = 'block';
			}
		});

		card.querySelector('.btn-delete').addEventListener('click', () => handlers.deleteKeychain(id));
		return card;
	};

	const createTreeGroup = (sig, wsIds, treeTemplate, rowTemplate) => {
		const refWs = Config.workspaces[wsIds[0]];

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
		for (const [kcId, keychain] of Object.entries(Config.keychains)) {
			selectKc.appendChild(h('option', { value: kcId }, `${keychain.name} (${keychain.provider})`));
		}
		selectKc.value = refWs.keychainId || '';

		// Visibility Toggle for Dropbox
		const toggleGhVisibility = () => {
			const selectedKcId = selectKc.value;
			const provider = selectedKcId && Config.keychains[selectedKcId]
				? Config.keychains[selectedKcId].provider : 'github';
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
			wsIds.forEach(id => Config.workspaces[id].keychainId = e.target.value);
			toggleGhVisibility();
		});
		ownerEl.addEventListener('input', e => {
			wsIds.forEach(id => Config.workspaces[id].owner = e.target.value);
			updateTreeTitle();
		});
		repoEl.addEventListener('input', e => {
			wsIds.forEach(id => Config.workspaces[id].repo = e.target.value);
			updateTreeTitle();
		});
		branchEl.addEventListener('input', e => wsIds.forEach(id => Config.workspaces[id].branch = e.target.value));
		hostEl.addEventListener('input', e => wsIds.forEach(id => Config.workspaces[id].host = e.target.value));
		commitToggle.addEventListener('change', e => wsIds.forEach(id => Config.workspaces[id].askForCommitMsg = e.target.checked));

		// Mount Point Spawner
		groupEl.querySelector('.btn-add-mount').addEventListener('click', () => handlers.createMountPoint(refWs));

		// Render the child rows
		for (const id of wsIds) {
			const ws = Config.workspaces[id];
			const isActive = id === Config.activeWorkspaceId;
			listEl.appendChild(createMountRow(id, ws, wsIds, isActive, rowTemplate));
		}

		return groupEl;
	};

	const createMountRow = (id, ws, wsIds, isActive, rowTemplate) => {
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
		const currentRoot = Path.cleanPath(ws.rootDir);
		const hasChildren = wsIds.some(childId => {
			if (childId === id) return false;
			const childRoot = Path.cleanPath(Config.workspaces[childId].rootDir);
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
			btnSwitch.addEventListener('click', () => handlers.switchWorkspace(id));
		}

		rowEl.querySelector('.btn-clear').addEventListener('click', () => handlers.clearDB(id));
		rowEl.querySelector('.btn-delete').addEventListener('click', () => handlers.deleteWorkspace(id));

		return rowEl;
	};

	return {
		// handlers: { save, createKeychain, deleteKeychain(id), linkDropbox(id),
		//   createWorkspace, createMountPoint(parentWs), switchWorkspace(id),
		//   clearDB(id), deleteWorkspace(id), isSymlinkEditMode(), setSymlinkEditMode(bool) }
		bind(hs) { handlers = hs; },

		render() {
			DOM.settingsPanel.replaceChildren();

			// ==========================================
			// 0: GLOBAL OVERRIDES
			// ==========================================
			DOM.settingsPanel.appendChild(
				h('div', { class: 'settings-header', style: 'margin-bottom: 20px; padding-bottom: 15px; border-bottom: 1px solid var(--border);' },
					h('label', { class: 'symlink-mode-label' },
						h('input', {
						    type: 'checkbox',
						    ...(handlers.isSymlinkEditMode() ? { checked: true } : {}),
						    onchange: e => handlers.setSymlinkEditMode(e.target.checked)
						}),
						'Edit Symlink'
					)
				)
			);

			// ==========================================
			// 1: KEYCHAINS (CREDENTIALS)
			// ==========================================
			DOM.settingsPanel.appendChild(
				h('div', { class: 'settings-header' },
					h('h2', { style: 'margin: 0;' }, 'Keychains'),
					h('button', { onclick: () => handlers.createKeychain(), style: 'background: var(--accent); color: white; border: none;' }, '+ New Keychain')
				)
			);

			const kcTemplate = document.getElementById('keychain-card-template');
			for (const [id, kc] of Object.entries(Config.keychains)) {
				DOM.settingsPanel.appendChild(createKeychainCard(id, kc, kcTemplate));
			}

			// ==========================================
			// 2: WORKSPACES (THE FOREST)
			// ==========================================
			DOM.settingsPanel.appendChild(
				h('div', { class: 'settings-header', style: 'margin-top: 40px;' },
					h('h2', { style: 'margin: 0;' }, 'Workspaces'),
					h('button', { onclick: () => handlers.createWorkspace(), style: 'background: var(--accent); color: white; border: none;' }, '+ New Origin Tree')
				)
			);

			const treeTemplate = document.getElementById('tree-group-template');
			const rowTemplate = document.getElementById('mount-row-template');

			for (const [sig, wsIds] of Object.entries(Forest.workspaceTrees())) {
				DOM.settingsPanel.appendChild(createTreeGroup(sig, wsIds, treeTemplate, rowTemplate));
			}

			// ==========================================
			// 3: GLOBAL SAVE
			// ==========================================
			DOM.settingsPanel.appendChild(
				h('button', {
					class: 'settings-save-btn',
					onclick: () => handlers.save()
				}, '💾 Save All Configurations')
			);

			// If this doesn't match your last build, you're looking at a stale copy.
			DOM.settingsPanel.appendChild(
				h('div', { class: 'build-info', style: 'margin-top: 20px; font-size: 12px; color: #666; text-align: center;' }, BuildInfo.label)
			);
		},
	};
});
