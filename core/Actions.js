const Actions = {
	// =====================================================================
	// KEYCHAIN MANAGEMENT
	// =====================================================================
	createKeychain() {
		const name = prompt('Enter keychain name (e.g., Personal GitHub, Work Dropbox):');
		if (!name) return;

		const id = 'kc_' + Date.now();
		AppState.keychains[id] = {
			name: name,
			provider: 'github', // default
			token: '',
			appKey: '',
			refreshToken: ''
		};

		localStorage.setItem('notes_keychains', JSON.stringify(AppState.keychains));
		UI.renderSettings();
	},

	deleteKeychain(id) {
		// Prevent deletion if workspaces are relying on it
		const inUse = Object.values(AppState.workspaces).some(ws => ws.keychainId === id);
		if (inUse) return alert("Cannot delete: This keychain is currently linked to a workspace.");

		if (!confirm(`Delete keychain "${AppState.keychains[id].name}"?`)) return;

		delete AppState.keychains[id];
		localStorage.setItem('notes_keychains', JSON.stringify(AppState.keychains));
		UI.renderSettings();
	},

	// =====================================================================
	// WORKSPACE MANAGEMENT
	// =====================================================================
	createWorkspace() {
		const name = prompt('Enter workspace name (e.g., Docs, Frontend src):');
		if (!name) return;

		const kcIds = Object.keys(AppState.keychains);
		if (kcIds.length === 0) return alert("Please create a Keychain first.");

		const id = 'ws_' + Date.now();
		AppState.workspaces[id] = {
			name: name,
			dbName: 'NotesDB_' + id, 
			keychainId: kcIds[0], // Default to the first available keychain
			host: 'https://api.github.com', 
			owner: '', 
			repo: '', 
			branch: 'main',
			rootDir: '',      // e.g., 'src/docs'
			shallow: false,   // false = recursive IDE view, true = folder exploration
			pins: []
		};

		localStorage.setItem('notes_workspaces', JSON.stringify(AppState.workspaces));
		this.switchWorkspace(id);
		this.openSettings();
	},

	switchWorkspace(id, skipHistory = false) {
		const ws = AppState.workspaces[id];
		if (!ws) return;

		AppState.activeWorkspaceId = id;
		localStorage.setItem('notes_active_workspace', id);

		if (!ws.pins) ws.pins = [];
		AppState.pins = ws.pins;

		UI.resetEditor();
		DOM.searchBar.value = '';

		// History API Upgrade: Push the workspace switch into the session history
		if (!skipHistory) {
			history.pushState(
				{ workspaceId: id, filename: null }, 
				null, 
				window.location.pathname
			);
		} 

		UI.renderPins();
		UI.updateWorkspaceIndicator();
		UI.renderFileList();
		UI.showStatus(`Switched workspace: ${AppState.workspaces[id].name}`);
	},

	deleteWorkspace(id) {
		if (Object.keys(AppState.workspaces).length <= 1) return alert("You cannot delete your only workspace.");
		
		const wsName = AppState.workspaces[id].name;
		const dbName = AppState.workspaces[id].dbName;
		
		if (!confirm(`WARNING: Permanently delete workspace "${wsName}" AND wipe all its local data?\n\nThis action cannot be undone.`)) return;

		// 1. Purge the isolated database directly from the browser's storage
		indexedDB.deleteDatabase(dbName);

		// 2. Remove the workspace from memory
		delete AppState.workspaces[id];
		localStorage.setItem('notes_workspaces', JSON.stringify(AppState.workspaces));

		// 3. UI Routing
		if (AppState.activeWorkspaceId === id) {
			const fallbackId = Object.keys(AppState.workspaces)[0];
			this.switchWorkspace(fallbackId);
			this.openSettings(); 
		} else {
			UI.renderSettings();
		}
	},

	saveSettings() {
		// Save both state arrays simultaneously
		localStorage.setItem('notes_keychains', JSON.stringify(AppState.keychains));
		localStorage.setItem('notes_workspaces', JSON.stringify(AppState.workspaces));
		UI.showStatus('Configuration saved.');
	},

	openSettings() {
		UI.resetEditor();
		AppState.currentFilename = null;
		history.replaceState(null, null, window.location.pathname);

		DOM.filenameLabel.textContent = '⚙️ Settings & Profiles';

		DOM.editLayer.style.display = 'none';
		DOM.viewLayer.style.display = 'none';

		DOM.settingsPanel.style.display = 'block';
		UI.renderSettings();

		if (window.innerWidth < 768) DOM.sidebar.classList.add('collapsed');
	},

	// =====================================================================
	// FILE EDITOR OPERATIONS
	// =====================================================================
	async openFile(filename, skipHistory = false) {
		const note = await DBService.get(filename);
		if (!note) return;

		// --- THE SYMLINK INTERCEPTOR ---
		if (filename.endsWith('.symlink') && !AppState.isSymlinkEditMode) {
			try {
				const payload = JSON.parse(note.content || '{}');

				// Define which fields are actually valid for routing
				const matchableFields = ['provider', 'host', 'owner', 'repo', 'branch', 'rootDir'];
				const payloadKeys = Object.keys(payload).filter(k => matchableFields.includes(k));

				if (payloadKeys.length === 0) {
					return UI.showStatus(`⚠️ Error: Symlink contains no valid routing fields.`, true);
				}

				// Gather all workspaces that match every field provided in the payload
				const matchedIds = Object.keys(AppState.workspaces).filter(id => {
					const ws = AppState.workspaces[id];

					return payloadKeys.every(key => {
						// Special normalization for rootDir
						if (key === 'rootDir') {
							const wsRoot = (ws.rootDir || '').replace(/(^\/+|\/+$)/g, '');
							const targetRoot = (payload.rootDir || '').replace(/(^\/+|\/+$)/g, '');
							return wsRoot === targetRoot;
						}
						// Strict equality for all other provided fields
						return ws[key] === payload[key];
					});
				});

				// Evaluate the match results
				if (matchedIds.length === 1) {
					this.switchWorkspace(matchedIds[0]); // Teleport!
					return; 
				} else if (matchedIds.length > 1) {
					return UI.showStatus(`❌ Ambiguous symlink: Matches ${matchedIds.length} workspaces. Be more specific.`, true);
				} else {
					return UI.showStatus(`❌ Target workspace not found locally.`, true);
				}

			} catch (err) {
				return UI.showStatus(`⚠️ Error: Malformed symlink JSON.`, true);
			}
		}
		// -------------------------------

		// Standard Editor Boot Sequence
		if (!skipHistory) {
		    history.pushState(
		        { workspaceId: AppState.activeWorkspaceId, filename: filename }, 
		        null, 
		        '#' + encodeURIComponent(filename)
		    );
		}

		if (window.innerWidth < 768) {
			DOM.sidebar.classList.add('collapsed');
		}

		UI.setEditorActive(filename, note.content);
		UI.renderFileList(DOM.searchBar.value, false);
	},

	async createFile() {
		let filename = prompt('Enter filename (e.g., folder/draft.txt):');
		if (!filename) return;
		if (!filename.includes('.')) filename += '.txt'; 

		if (await DBService.get(filename)) return alert('File already exists locally.');

		await DBService.put({ filename, content: '', last_synced_sha: null, remote_sha: null, is_dirty: true });
		AppState.syncChannel.postMessage({ type: 'SIDEBAR_REFRESH' });
		this.openFile(filename);
	},

	async handleFileUpload(event) {
		const file = event.target.files[0];
		if (!file) return;

		event.target.value = '';

		if (file.size > SyncService.fileUploadSizeLimit()) {
			return UI.showStatus('File is too large.', true);
		}

		let filename = prompt('Confirm or rename file path (e.g., archive.zip):', file.name);
		if (!filename) return;

		const existing = await DBService.get(filename);
		if (existing && !confirm(`Overwrite existing local file "${filename}"?`)) return;

		const isText = Utils.isTextFile(filename);
		let content;

		if (!isText) {
			content = new Blob([file], { type: file.type || 'application/octet-stream' });
		} else {
			content = await file.text();
		}

		await DBService.put({
			filename,
			content,
			last_synced_sha: existing ? existing.last_synced_sha : null,
			remote_sha: existing ? existing.remote_sha : null,
			is_dirty: true 
		});

		UI.showStatus(`Successfully imported ${filename}.`);
		AppState.syncChannel.postMessage({ type: 'SIDEBAR_REFRESH' });
		this.openFile(filename);
	},

	handleTyping(newContent) {
		if (!AppState.currentFilename) return;
		clearTimeout(AppState.typingTimer);

		AppState.typingTimer = setTimeout(async () => {
			const note = await DBService.get(AppState.currentFilename);
			if (note && note.content !== newContent) {
				note.content = newContent; 
				note.is_dirty = true;
				await DBService.put(note);

				AppState.syncChannel.postMessage({ type: 'LOCAL_EDIT', filename: AppState.currentFilename });
				UI.renderFileList(DOM.searchBar.value, false);
			}
		}, 500); 
	},

	async toggleViewMode() {
		const plugin = AppState.activePlugin;
		if (!plugin || !plugin.supportedModes.includes('view') || !plugin.supportedModes.includes('edit')) return;

		AppState.isViewMode = !AppState.isViewMode;
		UI.applyModeVisibility();

		if (plugin.onModeSwitch) await plugin.onModeSwitch(AppState.isViewMode);
	},

	// =====================================================================
	// SYNC & DB OPERATIONS
	// =====================================================================
	async clearDB(id) {
		const ws = AppState.workspaces[id];
		if (!ws) return;

		if (!confirm(`WARNING: Permanently wipe all local notes for workspace "${ws.name}"?\n\n(This does not delete the workspace itself, just its offline cache.)`)) return;

		try {
			if (id === AppState.activeWorkspaceId) {
				await DBService.clear();
				UI.resetEditor();
				history.replaceState(null, null, window.location.pathname);
				UI.renderFileList();
				AppState.syncChannel.postMessage({ type: 'SIDEBAR_REFRESH' });
				UI.showStatus(`Local cache cleared for ${ws.name}.`);
			} else {
				indexedDB.deleteDatabase(ws.dbName);
				UI.showStatus(`Local cache cleared for ${ws.name}.`);
			}
		} catch(err) {
			UI.showStatus(`Failed to clear local cache.`, true);
		}
	},

	async deleteFile() {
		const filename = AppState.currentFilename;
		if (!filename) return;
		const note = await DBService.get(filename);
		if (!note) return;

		const msg = note.last_synced_sha ? `Delete ${filename} from local AND remote?` : `Delete ${filename} locally?`;
		if (!confirm(msg)) return;

		try {
			if (note.last_synced_sha) {
				UI.showStatus(`Deleting ${filename} remotely...`);
				await SyncService.deleteFile(filename, note.last_synced_sha);
			}
			await DBService.delete(filename);
			UI.resetEditor();
			history.replaceState(null, null, window.location.pathname);
			AppState.syncChannel.postMessage({ type: 'SIDEBAR_REFRESH' });
			UI.renderFileList();
			UI.showStatus('File deleted successfully.');
		} catch (err) {
			UI.showStatus(`Error: ${err.message}`, true);
		}
	},

	async refreshTree() {
		try {
			UI.showStatus('Refreshing file list remotely...');
			const treeData = await SyncService.getTree();

			const files = treeData.tree.filter(item => item.type === 'blob');

			for (const file of files) {
				let localNote = await DBService.get(file.path);
				if (!localNote) {
					await DBService.put({ filename: file.path, content: '', last_synced_sha: null, remote_sha: file.sha, is_dirty: false });
				} else {
					localNote.remote_sha = file.sha;
					await DBService.put(localNote);
				}
			}
			UI.showStatus('File list updated.');
			AppState.syncChannel.postMessage({ type: 'SIDEBAR_REFRESH' });
			UI.renderFileList(DOM.searchBar.value, false);
		} catch (err) {
			UI.showStatus(`Refresh failed: ${err.message}`, true);
		}
	},

	async pullFile() {
		const filename = AppState.currentFilename;
		if (!filename) return;

		try {
			let localNote = await DBService.get(filename);
			UI.showStatus(`Pulling ${filename}...`);

			const isBinary = Utils.isImageFile(filename) || Utils.isPdfFile(filename);
			const fileResponse = await SyncService.getFile(filename);

			if (!localNote) {
				localNote = { filename, content: '', last_synced_sha: null, remote_sha: null, is_dirty: false };
			}

			if (isBinary) {
				localNote.content = fileResponse; 
				localNote.is_dirty = false;
				localNote.last_synced_sha = localNote.remote_sha; 
			} else {
				const remoteContent = Utils.atou(fileResponse.content);
				if (localNote.is_dirty && localNote.content !== remoteContent) {
					const choice = prompt(`Conflict in ${filename}!\nd: Insert Diff markers\nw: Overwrite local with remote\ni: Ignore remote`, "d");
					if (choice === null) return UI.showStatus("Pull cancelled.");

					if (choice === "w") {
						localNote.content = remoteContent;
						localNote.is_dirty = false;
					} else if (choice == "i") {
						localNote.is_dirty = true;
					} else {
						UI.showStatus(`Loading diff engine...`);
						try {
							await Utils.loadResource("https://cdnjs.cloudflare.com/ajax/libs/jsdiff/5.1.0/diff.min.js");
						} catch (err) {
							return UI.showStatus(`Error: Failed to load diff engine. Merge cancelled.`, true);
						}

						UI.showStatus(`Injecting merge markers...`, true);
						if (typeof Diff !== 'undefined') {
							let merged = "";
							Diff.diffLines(remoteContent, localNote.content).forEach(p => {
								if (p.added) merged += `<<<<<<< LOCAL\n${p.value}\n=======\n`;
								else if (p.removed) merged += `${p.value}>>>>>>> REMOTE\n`;
								else merged += p.value;
							});
							localNote.content = merged;
						} else {
							localNote.content = `<<<<<<< LOCAL\n${localNote.content}\n=======\n${remoteContent}\n>>>>>>> REMOTE`;
						}
						localNote.is_dirty = true; 
					}
				} else {
					localNote.content = remoteContent;
					localNote.is_dirty = false;
				}
				localNote.last_synced_sha = fileResponse.sha;
				localNote.remote_sha = fileResponse.sha;
			}

			await DBService.put(localNote);
			UI.setEditorActive(filename, localNote.content);
			UI.showStatus(`Successfully pulled ${filename}.`);
			AppState.syncChannel.postMessage({ type: 'SIDEBAR_REFRESH' });
			UI.renderFileList(DOM.searchBar.value, false);
		} catch (err) {
			UI.showStatus(`Pull failed: ${err.message}`, true);
		}
	},

	async pushFile() {
		const filename = AppState.currentFilename;
		if (!filename) return;

		try {
			const note = await DBService.get(filename);
			if (!note || !note.is_dirty) return UI.showStatus(`${filename} is already up to date.`);

			UI.showStatus(`Pushing ${filename}...`);

			let base64Content;

			if (typeof note.content === 'object' && note.content !== null) {
				const buffer = await new Response(note.content).arrayBuffer();
				const bytes = new Uint8Array(buffer);

				let binary = '';
				const chunkSize = 8192;
				for (let i = 0; i < bytes.length; i += chunkSize) {
					binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
				}
				base64Content = btoa(binary);
			} else {
				base64Content = Utils.utoa(String(note.content));
			}

			const responseData = await SyncService.putFile(filename, base64Content, note.last_synced_sha);

			note.last_synced_sha = responseData.content.sha;
			note.remote_sha = responseData.content.sha;
			note.is_dirty = false;
			await DBService.put(note);

			UI.showStatus(`Successfully pushed ${filename}.`);
			AppState.syncChannel.postMessage({ type: 'SIDEBAR_REFRESH' });
			UI.renderFileList(DOM.searchBar.value, false);
		} catch (err) {
			UI.showStatus(`Push error: ${err.message}`, true);
		}
	},

	// =====================================================================
	// PIN OPERATIONS (Workspace Contextual)
	// =====================================================================
	addPin() {
		const pin = prompt('Enter a filename or directory path to pin (e.g., docs/ or README.md):',
			AppState.currentFilename || '');
		if (!pin) return;

		if (!AppState.pins.includes(pin)) {
			AppState.pins.push(pin);
			
			this.saveSettings(); 
			UI.renderPins();
		}
	},

	removePin(pin, event) {
		event.stopPropagation();
		const index = AppState.pins.indexOf(pin);
		if (index > -1) {
			AppState.pins.splice(index, 1);
			this.saveSettings(); 
			UI.renderPins();
		}
	},

	async handlePinClick(pin) {
		const note = await DBService.get(pin);

		if (note) {
			this.openFile(pin);
		} else {
			DOM.searchBar.value = pin;
			UI.renderFileList(pin, false);
		}
	},

	// =====================================================================
	// DROPBOX OAUTH HANDLERS
	// =====================================================================
	async linkDropboxPKCE(kcId) {
		const keychain = AppState.keychains[kcId];
		const key = keychain.appKey;
		
		if (!key) return alert("Please enter your App Key first (and ensure it is saved).");

		const verifier = Utils.generateCodeVerifier();
		const challenge = await Utils.generateCodeChallenge(verifier);

		sessionStorage.setItem('dbx_pkce_verifier', verifier);
		sessionStorage.setItem('dbx_pkce_keychain_id', kcId);

		const redirectUri = window.location.origin + window.location.pathname;
		const authUrl = `https://www.dropbox.com/oauth2/authorize?client_id=${key}&response_type=code&code_challenge=${challenge}&code_challenge_method=S256&token_access_type=offline&redirect_uri=${encodeURIComponent(redirectUri)}`;
		window.location.href = authUrl; 
	},

	async handlePKCERedirect() {
		const params = new URLSearchParams(window.location.search);
		const code = params.get('code');
		const verifier = sessionStorage.getItem('dbx_pkce_verifier');
		const kcId = sessionStorage.getItem('dbx_pkce_keychain_id');

		if (!code || !verifier || !kcId) return false;

		window.history.replaceState({}, document.title, window.location.pathname);
		sessionStorage.removeItem('dbx_pkce_verifier');
		sessionStorage.removeItem('dbx_pkce_keychain_id'); 

		const keychain = AppState.keychains[kcId];
		if (!keychain) return false;

		try {
			const redirectUri = window.location.origin + window.location.pathname;
			const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					client_id: keychain.appKey, 
					grant_type: 'authorization_code',
					code: code,
					code_verifier: verifier,
					redirect_uri: redirectUri
				})
			});

			const data = await res.json();

			if (!res.ok) {
				console.error("DROPBOX API ERROR:", data);
				throw new Error(data.error_description || data.error || "Unknown Auth Failure");
			}

			keychain.provider = 'dropbox';
			keychain.token = data.access_token;
			keychain.refreshToken = data.refresh_token; 

			localStorage.setItem('notes_keychains', JSON.stringify(AppState.keychains));

			return true;
		} catch (err) {
			alert(`PKCE Linking failed: ${err.message}`);
			return false;
		}
	},
	ensureDefaultState() {
		// 1. Check if we already have a valid, active workspace. If so, we are done.
		if (AppState.activeWorkspace) {
			return; 
		}

		// 2. We don't have an active workspace. Do we have ANY workspaces left?
		// (This handles the edge case where the active ID was corrupted or deleted)
		const existingWsIds = Object.keys(AppState.workspaces);
		if (existingWsIds.length > 0) {
			this.switchWorkspace(existingWsIds[0]);
			return;
		}

		// 3. The app is completely blank. We must generate the default relational state.
		let defaultKcId;
		const existingKcIds = Object.keys(AppState.keychains);

		if (existingKcIds.length > 0) {
			defaultKcId = existingKcIds[0];
		} else {
			// Create an empty default Keychain
			defaultKcId = 'kc_default';
			AppState.keychains[defaultKcId] = {
				name: 'Default Credentials',
				provider: 'github',
				token: '',
				appKey: '',
				refreshToken: ''
			};
			localStorage.setItem('notes_keychains', JSON.stringify(AppState.keychains));
		}

		// 4. Create the default Workspace linked to the Keychain
		const defaultWsId = 'ws_default';
		AppState.workspaces[defaultWsId] = {
			name: 'Local Workspace',
			dbName: 'NotesDB_default', 
			keychainId: defaultKcId, 
			host: 'https://api.github.com', 
			owner: '', 
			repo: '', 
			branch: 'main',
			rootDir: '',      
			shallow: false,
			pins: []
		};
		localStorage.setItem('notes_workspaces', JSON.stringify(AppState.workspaces));

		// 5. Safely boot the app into the new default workspace
		this.switchWorkspace(defaultWsId);
	}
};
