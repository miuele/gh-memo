const Actions = {
	createProfile(name) {
		if (!name) name = prompt('Enter profile name (e.g., Personal, Work, Local Server):');
		if (!name) return;

		const id = 'profile_' + Date.now();
		AppState.profiles[id] = {
			name: name,
			dbName: 'NotesDB_' + id, 
			config: { 
				provider: 'github',
				host: 'https://api.github.com', 
				token: '', 
				owner: '', 
				repo: '', 
				branch: 'main' 
			},
			pins: []
		};

		localStorage.setItem('notes_profiles', JSON.stringify(AppState.profiles));
		this.switchProfile(id);
		this.openSettings(); // Prompt for settings immediately
	},

	switchProfile(profileId) {
		if (!AppState.profiles[profileId]) return;

		// 1. Update Master State
		AppState.activeProfileId = profileId;
		localStorage.setItem('notes_active_profile', profileId);

		// 2. Hydrate Context
		const profile = AppState.profiles[profileId];
		AppState.config = profile.config;
		AppState.pins = profile.pins || [];

		// 3. Brutally reset the UI to prevent data bleeding
		UI.resetEditor();
		DOM.searchBar.value = '';
		history.replaceState(null, null, window.location.pathname); 

		// 4. Boot the new environment
		UI.renderPins();
		UI.renderFileList();
		UI.showStatus(`Switched to profile: ${profile.name}`);
	},

	saveProfile() {
		if (!AppState.activeProfileId) return;
		AppState.profiles[AppState.activeProfileId].config = AppState.config;
		AppState.profiles[AppState.activeProfileId].pins = AppState.pins;
		localStorage.setItem('notes_profiles', JSON.stringify(AppState.profiles));
	},

	openSettings() {
		UI.resetEditor();
		AppState.currentFilename = null;
		history.replaceState(null, null, window.location.pathname);

		DOM.filenameLabel.textContent = '⚙️ Settings & Profiles';

		// FIX: Hide the new agnostic layers instead of the old editor
		DOM.editLayer.style.display = 'none';
		DOM.viewLayer.style.display = 'none';

		DOM.settingsPanel.style.display = 'block';
		UI.renderSettings();

		if (window.innerWidth < 768) DOM.sidebar.classList.add('collapsed');
	},

	// Add these two new functions:
	updateProfileConfig(id) {
		if (!AppState.profiles[id]) return;
		const c = AppState.profiles[id].config;

		c.provider = document.getElementById(`cfg-provider-${id}`).value; // Capture Provider
		c.host = document.getElementById(`cfg-host-${id}`).value.trim();
		c.owner = document.getElementById(`cfg-owner-${id}`).value.trim();
		c.repo = document.getElementById(`cfg-repo-${id}`).value.trim();
		c.branch = document.getElementById(`cfg-branch-${id}`).value.trim();

		// Only overwrite the token manually if GitHub is the active provider.
		// Dropbox manages its own token via the OAuth handshake.
		if (c.provider === 'github') {
			c.token = document.getElementById(`cfg-token-${id}`).value.trim();
		}

		localStorage.setItem('notes_profiles', JSON.stringify(AppState.profiles));

		if (id === AppState.activeProfileId) AppState.config = c;
		UI.showStatus(`Saved config for ${AppState.profiles[id].name}`);
	},

	deleteProfile(id) {
		if (Object.keys(AppState.profiles).length <= 1) return alert("You cannot delete your only profile.");

		const profileName = AppState.profiles[id].name;
		const dbName = AppState.profiles[id].dbName;

		if (!confirm(`WARNING: Permanently delete profile "${profileName}" AND wipe all its local data?\n\nThis action cannot be undone.`)) return;

		// 1. Purge the isolated database directly from the browser's storage
		indexedDB.deleteDatabase(dbName);

		// 2. Remove the profile from memory
		delete AppState.profiles[id];
		localStorage.setItem('notes_profiles', JSON.stringify(AppState.profiles));

		// 3. UI Routing
		if (AppState.activeProfileId === id) {
			// Fallback to the first available profile if we deleted the active one
			const fallbackId = Object.keys(AppState.profiles)[0];
			this.switchProfile(fallbackId);
			this.openSettings(); // Re-open settings to show the updated list
		} else {
			// We deleted a background profile, just re-render the list
			UI.renderSettings();
		}
	},

	async openFile(filename, skipHistory = false) {
		const note = await DBService.get(filename);
		if (!note) return;

		// Push to the browser's History API
		if (!skipHistory) {
			history.pushState(null, null, '#' + encodeURIComponent(filename));
		}

		// If we are on a mobile device (screen width < 768px), auto-collapse the sidebar
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

		// Hard limit to protect browser memory and API limits
		if (file.size > SyncService.fileUploadSizeLimit()) {
			return UI.showStatus('File is too large.', true);
		}

		let filename = prompt('Confirm or rename file path (e.g., archive.zip):', file.name);
		if (!filename) return;

		const existing = await DBService.get(filename);
		if (existing && !confirm(`Overwrite existing local file "${filename}"?`)) return;

		// FIX: Treat anything that isn't explicitly text as a binary Blob
		const isText = Utils.isTextFile(filename);
		let content;

		if (!isText) {
			// Fallback to octet-stream for generic unknown files
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
			if (note) {
				note.content = newContent; // <--- Uses the passed value
				note.is_dirty = true;
				await DBService.put(note);

				AppState.syncChannel.postMessage({ type: 'LOCAL_EDIT', filename: AppState.currentFilename });
				UI.renderFileList(DOM.searchBar.value, false);
			}
		}, 500); 
	},

	async clearDB(id) {
		const profile = AppState.profiles[id];
		if (!profile) return;

		if (!confirm(`WARNING: Permanently wipe all local notes for profile "${profile.name}"?\n\n(This does not delete the profile itself, just its offline cache.)`)) return;

		try {
			if (id === AppState.activeProfileId) {
				// Active Profile: Clear via DBService and reset the live UI
				await DBService.clear();
				UI.resetEditor();
				history.replaceState(null, null, window.location.pathname);
				UI.renderFileList();
				AppState.syncChannel.postMessage({ type: 'SIDEBAR_REFRESH' });
				UI.showStatus(`Local cache cleared for ${profile.name}.`);
			} else {
				// Background Profile: Just drop the IndexedDB from the browser silently
				indexedDB.deleteDatabase(profile.dbName);
				UI.showStatus(`Local cache cleared for ${profile.name}.`);
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

		const msg = note.last_synced_sha ? `Delete ${filename} from local AND GitHub?` : `Delete ${filename} locally?`;
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

			// Show ALL files in the sidebar, regardless of type or size
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

			// 3. Proceed with the network request
			const fileResponse = await SyncService.getFile(filename);

			// Fallback initialization just in case the file wasn't in IndexedDB yet
			if (!localNote) {
				localNote = { filename, content: '', last_synced_sha: null, remote_sha: null, is_dirty: false };
			}

			if (isBinary) {
				// Binary Handling (Blobs)
				localNote.content = fileResponse; // fileResponse is a raw Blob here
				localNote.is_dirty = false;
				localNote.last_synced_sha = localNote.remote_sha; // Use the known SHA from the tree
			} else {
				// Text Handling (Base64 Strings)
				const remoteContent = Utils.atou(fileResponse.content);
				if (localNote.is_dirty && localNote.content !== remoteContent) {
					const choice = prompt(`Conflict in ${filename}!\nd: Insert Diff markers\nw: Overwrite local with remote`, "d");
					if (choice === null) return UI.showStatus("Pull cancelled.");

					if (choice === "w") {
						localNote.content = remoteContent;
						localNote.is_dirty = false;
					} else {
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

			// THE INESCAPABLE NET: If it is an object (Blob, File, or stripped IDB object), it is binary.
			if (typeof note.content === 'object' && note.content !== null) {

				// Force extraction via Response wrapper (bypasses missing prototype methods)
				const buffer = await new Response(note.content).arrayBuffer();
				const bytes = new Uint8Array(buffer);

				// Encode in chunks to prevent memory limits
				let binary = '';
				const chunkSize = 8192;
				for (let i = 0; i < bytes.length; i += chunkSize) {
					binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
				}
				base64Content = btoa(binary);

			} else {
				// It is strictly text.
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

	addPin() {
		const pin = prompt('Enter a filename or directory path to pin (e.g., docs/ or README.md):',
			AppState.currentFilename || '');
		if (!pin) return;

		if (!AppState.pins.includes(pin)) {
			AppState.pins.push(pin);
			this.saveProfile(); // <--- Changed
			UI.renderPins();
		}
	},

	removePin(pin, event) {
		event.stopPropagation();
		AppState.pins = AppState.pins.filter(p => p !== pin);
		this.saveProfile(); // <--- Changed
		UI.renderPins();
	},

	async handlePinClick(pin) {
		const note = await DBService.get(pin);

		if (note) {
			// Route A: Exact file exists. Open it normally.
			this.openFile(pin);
		} else {
			// Route B: It's a directory (or missing file). Inject into search bar.
			DOM.searchBar.value = pin;
			UI.renderFileList(pin, false);
		}
	},

	async toggleViewMode() {
		const plugin = AppState.activePlugin;
		if (!plugin || !plugin.supportedModes.includes('view') || !plugin.supportedModes.includes('edit')) return;

		AppState.isViewMode = !AppState.isViewMode;
		UI.applyModeVisibility();

		if (plugin.onModeSwitch) {
			await plugin.onModeSwitch(AppState.isViewMode);
		}
	},

	async linkDropboxPKCE(id) {
		const key = document.getElementById(`cfg-dbx-key-${id}`).value.trim();
		if (!key) return alert("Please enter your App Key first.");

		const verifier = Utils.generateCodeVerifier();
		const challenge = await Utils.generateCodeChallenge(verifier);

		sessionStorage.setItem('dbx_pkce_verifier', verifier);
		sessionStorage.setItem('dbx_pkce_profile_id', id);
		sessionStorage.setItem('dbx_pkce_client_id', key); // <--- ADD THIS LINE

		const redirectUri = window.location.origin + window.location.pathname;
		const authUrl = `https://www.dropbox.com/oauth2/authorize?client_id=${key}&response_type=code&code_challenge=${challenge}&code_challenge_method=S256&token_access_type=offline&redirect_uri=${encodeURIComponent(redirectUri)}`;
		window.location.href = authUrl; 
	},

	async handlePKCERedirect() {
		const params = new URLSearchParams(window.location.search);
		const code = params.get('code');
		const verifier = sessionStorage.getItem('dbx_pkce_verifier');
		const profileId = sessionStorage.getItem('dbx_pkce_profile_id');
		const clientId = sessionStorage.getItem('dbx_pkce_client_id'); // <--- PULL IT HERE

		if (!code || !verifier || !profileId || !clientId) return false;

		window.history.replaceState({}, document.title, window.location.pathname);
		sessionStorage.removeItem('dbx_pkce_verifier');
		sessionStorage.removeItem('dbx_pkce_profile_id');
		sessionStorage.removeItem('dbx_pkce_client_id'); // Clean up

		const profile = AppState.profiles[profileId];
		if (!profile) return false;

		try {
			const redirectUri = window.location.origin + window.location.pathname;
			const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					client_id: clientId, // <--- USE IT HERE
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

			// 4. Save to the profile permanently!
			profile.config.provider = 'dropbox';
			profile.config.appKey = clientId; // <--- SAVE IT HERE
			profile.config.appSecret = ''; 
			profile.config.token = data.access_token;
			profile.config.refreshToken = data.refresh_token; 

			localStorage.setItem('notes_profiles', JSON.stringify(AppState.profiles));
			if (profileId === AppState.activeProfileId) AppState.config = profile.config;

			return true;
		} catch (err) {
			alert(`PKCE Linking failed: ${err.message}`);
			return false;
		}
	},
};
