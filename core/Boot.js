window.onload = () => {

	initDOM();

	// --- CATCH DROPBOX PKCE REDIRECT ---
	Actions.handlePKCERedirect().then((wasRedirect) => {
		// Hydrate the active context
		Actions.switchProfile(AppState.activeProfileId);

		if (wasRedirect) {
			// If we just finished PKCE, open the settings panel to show success
			Actions.configureGitHub();
			UI.showStatus("Dropbox linked successfully via PKCE!");
		} else {
			// Normal Deep Link Boot Sequence
			const hash = window.location.hash.substring(1);
			if (hash) {
				Actions.openFile(decodeURIComponent(hash), true);
			} else {
				UI.resetEditor();
				UI.renderFileList();
			}
		}
	});

	// Hydrate the active context BEFORE attempting to load any files
	Actions.switchProfile(AppState.activeProfileId);

	// 1. Deep Link Boot Sequence
	const hash = window.location.hash.substring(1);
	if (hash) {
		// Boot directly into the requested file
		Actions.openFile(decodeURIComponent(hash), true);
	} else {
		// Boot into the empty state
		UI.resetEditor();
		UI.renderFileList();
	}

	// 2. Wire up search bar events locally
	DOM.searchBar.addEventListener('input', () => UI.renderFileList(DOM.searchBar.value, false));
	DOM.searchBar.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') {
			e.preventDefault();
			UI.renderFileList(DOM.searchBar.value, true);
		}
	});

	// 3. View layer link interceptor
	DOM.viewLayer.addEventListener('click', (e) => {
		let target = e.target;
		while (target && target.tagName !== 'A') target = target.parentNode;

		if (target && target.tagName === 'A') {
			const href = target.getAttribute('href');

			if (href && !href.match(/^(http|https|mailto:|data:|#)/i)) {
				e.preventDefault(); 

				// mdbook links often include anchors (e.g., chapter.html#section-1)
				// We must strip the hash before looking up the actual filename
				const pathWithoutHash = href.split('#')[0];
				const targetPath = Utils.resolvePath(AppState.currentFilename, pathWithoutHash);

				// Clear the search bar so we don't accidentally filter the tree
				DOM.searchBar.value = ''; 

				(async () => {
					let finalPath = targetPath;
					let note = await DBService.get(finalPath);

					if (!note) {
						// 1. Fetch all known filenames (fast, keys only)
						const allKeys = await DBService.getAllKeys();

						// 2. Parse the target path using our utility
						const target = Utils.parsePath(targetPath);

						// 3. Find files in the SAME directory with the SAME basename
						const candidates = allKeys.filter(key => {
							const k = Utils.parsePath(key);
							return k.dir === target.dir && k.basename === target.basename && key !== targetPath;
						});

						// 4. Resolve routing IF AND ONLY IF there is exactly one match
						if (candidates.length === 1) {
							finalPath = candidates[0];
							note = await DBService.get(finalPath);
							UI.showStatus(`Rerouted: ${target.filename} &rarr; ${Utils.parsePath(finalPath).filename}`);
						}
					}

					if (note) {
						Actions.openFile(finalPath);
					} else {
						UI.showStatus(`The file "${targetPath}" does not exist locally.`, true);
					}
				})();
			}
		}
	});
};

window.addEventListener('popstate', () => {
	// Read the hash from the URL (removing the # symbol)
	const hash = window.location.hash.substring(1);

	if (hash) {
		// The user navigated Back/Forward to a specific file
		Actions.openFile(decodeURIComponent(hash), true); // true = skip pushing state again
	} else {
		// The URL hash is empty. The user navigated Back to the root list.
		UI.resetEditor();
		UI.renderFileList(DOM.searchBar.value, false);
	}
});

window.addEventListener('offline', () => UI.showStatus('📴 You are offline. Changes will save locally.', true));
window.addEventListener('online', () => UI.showStatus('📶 You are back online. Safe to Push/Pull.'));

document.addEventListener('keydown', (e) => {
	if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
		e.preventDefault();
		AppState.currentFilename ? Actions.pushFile() : UI.showStatus("No file open to push.", true);
	}
	if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
		e.preventDefault();
		DOM.searchBar.focus();
		DOM.searchBar.select();
	}
	if (e.altKey && e.key === 'ArrowDown') {
		e.preventDefault();
		AppState.currentFilename ? Actions.pullFile() : UI.showStatus("No file open to pull.", true);
	}
	if (e.altKey && e.key.toLowerCase() === 'r') {
		e.preventDefault();
		Actions.refreshTree();
	}
});

document.addEventListener('paste', async (e) => {
	if (e.target.tagName === 'INPUT' || !e.target.closest('#sidebar')) {
		return; 
	}

	const clipboardData = e.clipboardData || window.clipboardData;
	const items = clipboardData.items;

	for (let i = 0; i < items.length; i++) {
		const item = items[i];

		if (item.type.indexOf('image') !== -1) {
			e.preventDefault(); 

			const blob = item.getAsFile();
			if (!blob) continue;

			const ext = blob.type.split('/')[1] || 'png';
			let filename = prompt('Upload image directly to repository:', `images/image.${ext}`);

			if (!filename) {
				UI.showStatus('Image upload cancelled.');
				return; 
			}

			if (!filename.includes('.')) filename += `.${ext}`;

			UI.showStatus(`Saving ${filename}...`);

			await DBService.put({
				filename: filename,
				content: blob,
				last_synced_sha: null,
				remote_sha: null,
				is_dirty: true 
			});

			// Only update the file tree, do not touch the editor
			AppState.syncChannel.postMessage({ type: 'SIDEBAR_REFRESH' });
			UI.showStatus(`Successfully saved ${filename}.`);

			break; 
		}
	}
});
