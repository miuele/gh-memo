define('actions/workspaces',
	['model/config', 'storage/notesDb', 'lib/tabChannel', 'ui/refs', 'ui/editor', 'ui/pins', 'ui/indicator', 'ui/fileList', 'ui/status', 'ui/settings', 'actions/settings'],
	(Config, DBService, Tabs, DOM, Editor, PinsView, Indicator, FileList, Status, SettingsView, Settings) => {

	const Workspaces = {
		create() {
			const kcIds = Object.keys(Config.keychains);
			if (kcIds.length === 0) return alert("Please create a Keychain first.");

			const repoName = prompt('Enter Repository (e.g., rust-lang/cargo) or leave blank for Dropbox:');
			if (repoName === null) return;

			let owner = '';
			let repo = repoName;
			if (repoName.includes('/')) {
				[owner, repo] = repoName.split('/');
			}

			// Auto-select the right keychain provider based on input
			let targetKcId = kcIds[0];
			if (!repoName) {
				const dbxKc = kcIds.find(id => Config.keychains[id].provider === 'dropbox');
				if (dbxKc) targetKcId = dbxKc;
			} else {
				const ghKc = kcIds.find(id => Config.keychains[id].provider === 'github');
				if (ghKc) targetKcId = ghKc;
			}

			const id = 'ws_' + Date.now();
			Config.workspaces[id] = {
				name: repoName ? repoName : 'Dropbox Storage',
				dbName: 'NotesDB_' + id,
				keychainId: targetKcId,
				host: 'https://api.github.com',
				owner: owner.trim(),
				repo: repo.trim(),
				branch: repoName ? 'main' : '',
				rootDir: '',
				shallow: false,
				askForCommitMsg: false,
			};

			Config.saveWorkspaces();
			Workspaces.switchTo(id);
			Settings.open();
		},

		createMountPoint(parentWs) {
			const newRoot = prompt(`Enter sub-directory path to mount (e.g., src/docs):`);
			if (newRoot === null) return; // User cancelled

			const id = 'ws_' + Date.now();

			// Clone all origin data, but reset the mount-specific data
			Config.workspaces[id] = {
				name: parentWs.name + ' (' + newRoot + ')',
				dbName: 'NotesDB_' + id,
				keychainId: parentWs.keychainId,
				host: parentWs.host,
				owner: parentWs.owner,
				repo: parentWs.repo,
				branch: parentWs.branch,
				rootDir: newRoot,
				shallow: false,
				askForCommitMsg: !!parentWs.askForCommitMsg,
			};

			SettingsView.render(); // Re-render to show the new row instantly
			// After render: it forces a parent with mounts below it to shallow
			// (backlog D7 moves that out of render). There's no Save button
			// to persist it later any more.
			Config.saveWorkspaces();
		},

		switchTo(id, skipHistory = false) {
			const ws = Config.workspaces[id];
			if (!ws) return;

			Config.setActiveWorkspace(id);

			Editor.reset();
			DOM.searchBar.value = '';

			// History API Upgrade: Push the workspace switch into the session history
			if (!skipHistory) {
				history.pushState(
					{ workspaceId: id, filename: null },
					null,
					window.location.pathname
				);
			}

			PinsView.render();
			Indicator.update();
			FileList.render();
			Status.show(`Switched workspace: ${Config.workspaces[id].name}`);
		},

		remove(id) {
			if (Object.keys(Config.workspaces).length <= 1) return alert("You cannot delete your only workspace.");

			const wsName = Config.workspaces[id].name;
			const dbName = Config.workspaces[id].dbName;

			if (!confirm(`WARNING: Permanently delete workspace "${wsName}" AND wipe all its local data?\n\nThis action cannot be undone.`)) return;

			// 1. Purge the isolated database directly from the browser's storage
			indexedDB.deleteDatabase(dbName);

			// 2. Remove the workspace from memory
			delete Config.workspaces[id];
			Config.saveWorkspaces();

			// 3. UI Routing
			if (Config.activeWorkspaceId === id) {
				const fallbackId = Object.keys(Config.workspaces)[0];
				Workspaces.switchTo(fallbackId);
				Settings.open();
			} else {
				SettingsView.render();
			}
		},

		// Wipes the local cache of a workspace (not the workspace itself).
		async clearDB(id) {
			const ws = Config.workspaces[id];
			if (!ws) return;

			if (!confirm(`WARNING: Permanently wipe all local notes for workspace "${ws.name}"?\n\n(This does not delete the workspace itself, just its offline cache.)`)) return;

			try {
				if (id === Config.activeWorkspaceId) {
					await DBService.clear();
					Editor.reset();
					history.replaceState(null, null, window.location.pathname);
					FileList.render();
					Tabs.post({ type: Tabs.SIDEBAR_REFRESH });
					Status.show(`Local cache cleared for ${ws.name}.`);
				} else {
					indexedDB.deleteDatabase(ws.dbName);
					Status.show(`Local cache cleared for ${ws.name}.`);
				}
			} catch(err) {
				Status.show(`Failed to clear local cache.`, true);
			}
		},

		// First run (or a corrupted active id): make sure there is an active workspace.
		ensureDefaultState() {
			// 1. Check if we already have a valid, active workspace. If so, we are done.
			if (Config.activeWorkspace) {
				return;
			}

			// 2. We don't have an active workspace. Do we have ANY workspaces left?
			// (This handles the edge case where the active ID was corrupted or deleted)
			const existingWsIds = Object.keys(Config.workspaces);
			if (existingWsIds.length > 0) {
				Workspaces.switchTo(existingWsIds[0]);
				return;
			}

			// 3. The app is completely blank. We must generate the default relational state.
			let defaultKcId;
			const existingKcIds = Object.keys(Config.keychains);

			if (existingKcIds.length > 0) {
				defaultKcId = existingKcIds[0];
			} else {
				// Create an empty default Keychain
				defaultKcId = 'kc_default';
				Config.keychains[defaultKcId] = {
					name: 'Default Credentials',
					provider: 'github',
					token: '',
					appKey: '',
					refreshToken: ''
				};
				Config.saveKeychains();
			}

			// 4. Create the default Workspace linked to the Keychain
			const defaultWsId = 'ws_default';
			Config.workspaces[defaultWsId] = {
				name: 'Local Workspace',
				dbName: 'NotesDB_default',
				keychainId: defaultKcId,
				host: 'https://api.github.com',
				owner: '',
				repo: '',
				branch: 'main',
				rootDir: '',
				shallow: false,
				askForCommitMsg: false,
			};
			Config.saveWorkspaces();

			// 5. Safely boot the app into the new default workspace
			Workspaces.switchTo(defaultWsId);
		},
	};

	return Workspaces;
});
