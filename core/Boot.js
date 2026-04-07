AppState.syncChannel.onmessage = (event) => {
	if (event.data.type === 'SIDEBAR_REFRESH') UI.renderFileList();

	if (event.data.type === 'LOCAL_EDIT' && AppState.currentFilename === event.data.filename) {
		if (!AppState.isFrozen) {
			AppState.isFrozen = true;

			// 1. Core locks global Chrome
			DOM.pullBtn.disabled = true;
			DOM.pushBtn.disabled = true;
			DOM.editLayer.style.opacity = '0.6';

			// 2. Plugin locks its specific inputs
			if (AppState.activePlugin && AppState.activePlugin.freeze) {
				AppState.activePlugin.freeze();
			} else {
				// Brutal fallback if a plugin forgets to implement freeze()
				DOM.editLayer.style.pointerEvents = 'none';
			}

			UI.showStatus(`⚠️ Edited in another tab.`, true);
		}
	}
};

window.addEventListener('DOMContentLoaded', async () => {
    // 1. Capture the DOM nodes
    initDOM();

    // 2. Heal the state if it's a first-time load (or orphaned)
    Actions.ensureDefaultState();
    
    // 3. Render the UI safely using the active workspace
	UI.updateWorkspaceIndicator();
    UI.renderFileList();
    UI.renderPins();
    
    // 4. Handle OAuth redirects if necessary
    await Actions.handlePKCERedirect();

    // 5. Wire up local DOM event listeners
    DOM.searchBar.addEventListener('input', () => UI.renderFileList(DOM.searchBar.value, false));
    DOM.searchBar.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            UI.renderFileList(DOM.searchBar.value, true);
        }
    });

    // 6. Wire up the View Layer link interceptor (Hypermedia routing)
    DOM.viewLayer.addEventListener('click', (e) => {
        let target = e.target;
        while (target && target.tagName !== 'A') target = target.parentNode;

        if (target && target.tagName === 'A') {
            const href = target.getAttribute('href');

            if (href && !href.match(/^(http|https|mailto:|data:|#)/i)) {
                e.preventDefault(); 
                
                const pathWithoutHash = href.split('#')[0];
                const targetPath = Utils.resolvePath(AppState.currentFilename, pathWithoutHash);

                DOM.searchBar.value = ''; 

                (async () => {
                    let finalPath = targetPath;
                    let note = await DBService.get(finalPath);

                    // Fuzzy routing fallback
                    if (!note) {
                        const allKeys = await DBService.getAllKeys();
                        const target = Utils.parsePath(targetPath);
                        const candidates = allKeys.filter(key => {
                            const k = Utils.parsePath(key);
                            return k.dir === target.dir && k.basename === target.basename && key !== targetPath;
                        });

                        if (candidates.length === 1) {
                            finalPath = candidates[0];
                            note = await DBService.get(finalPath);
                            UI.showStatus(`Rerouted: ${target.filename} \u2192 ${Utils.parsePath(finalPath).filename}`);
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
    
    // 7. Check if there is a file hash in the URL to open on boot
    const hash = window.location.hash.substring(1);
    if (hash) {
        Actions.openFile(decodeURIComponent(hash), true);
    }
});

window.addEventListener('popstate', (e) => {
    const state = e.state;

    // Route A: Rich Session Navigation (The user clicked Back/Forward)
    if (state && state.workspaceId) {
        // 1. If the history entry belongs to a different workspace, swap environments safely
        if (state.workspaceId !== AppState.activeWorkspaceId) {
            Actions.switchWorkspace(state.workspaceId, true); // true = skipHistory
        }
        
        // 2. Restore the specific file view, or reset to the root tree
        if (state.filename) {
            Actions.openFile(state.filename, true);
        } else {
            UI.resetEditor();
            UI.renderFileList(DOM.searchBar.value, false);
        }
        return;
    }

    // Route B: Cold Boot / Manual Hash Edit (No state object available)
    const hash = window.location.hash.substring(1);
    if (hash) {
        Actions.openFile(decodeURIComponent(hash), true);
    } else {
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
	// Allow paste when focus is on the sidebar
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
