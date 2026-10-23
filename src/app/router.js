// Navigation: history entries for files and workspace switches, the URL hash
// on boot, and relative links clicked inside rendered documents.
define('app/router',
	['model/config', 'model/target', 'storage/notesDb', 'lib/path', 'ui/refs', 'ui/editor', 'ui/fileList', 'ui/status', 'actions/files', 'actions/workspaces'],
	(Config, Target, DBService, Path, DOM, Editor, FileList, Status, Files, Workspaces) => {

	// Opens what a URL hash names (model/target), without adding history.
	const openTarget = (target) => {
		const found = Target.resolve(target);
		if (found.error) return Status.show(found.error, true);
		if (found.workspaceId !== Config.activeWorkspaceId || !found.filename) Workspaces.switchTo(found.workspaceId, true);
		if (found.filename) Files.open(found.filename, true);
	};

	const onPopState = (e) => {
		const state = e.state;

		// Route A: Rich Session Navigation (The user clicked Back/Forward)
		if (state && state.workspaceId) {
			// 1. If the history entry belongs to a different workspace, swap environments safely
			if (state.workspaceId !== Config.activeWorkspaceId) {
				Workspaces.switchTo(state.workspaceId, true); // true = skipHistory
			}

			// 2. Restore the specific file view, or reset to the root tree
			if (state.filename) {
				Files.open(state.filename, true);
			} else {
				Editor.reset();
				FileList.render(DOM.searchBar.value, false);
			}
			return;
		}

		// Route B: Cold Boot / Manual Hash Edit (No state object available)
		const hash = window.location.hash.substring(1);
		if (hash) {
			openTarget(Target.decode(hash));
		} else {
			Editor.reset();
			FileList.render(DOM.searchBar.value, false);
		}
	};

	// Hypermedia routing: a relative link in the view layer opens the local file.
	const onViewLayerClick = (e) => {
		let target = e.target;
		while (target && target.tagName !== 'A') target = target.parentNode;

		if (target && target.tagName === 'A') {
			const href = target.getAttribute('href');

			if (href && !href.match(/^(http|https|mailto:|data:|#)/i)) {
				e.preventDefault();

				const pathWithoutHash = href.split('#')[0];
				const targetPath = Path.resolvePath(Editor.currentFilename(), pathWithoutHash);

				DOM.searchBar.value = '';

				(async () => {
					let finalPath = targetPath;
					let note = await DBService.get(finalPath);

					// Fuzzy routing fallback
					if (!note) {
						const allKeys = await DBService.getAllKeys();
						const target = Path.parsePath(targetPath);
						const candidates = allKeys.filter(key => {
							const k = Path.parsePath(key);
							return k.dir === target.dir && k.basename === target.basename && key !== targetPath;
						});

						if (candidates.length === 1) {
							finalPath = candidates[0];
							note = await DBService.get(finalPath);
							Status.show(`Rerouted: ${target.filename} → ${Path.parsePath(finalPath).filename}`);
						}
					}

					if (note) {
						Files.open(finalPath);
					} else {
						Status.show(`The file "${targetPath}" does not exist locally.`, true);
					}
				})();
			}
		}
	};

	return {
		install() {
			window.addEventListener('popstate', onPopState);
		},

		// Needs the DOM.
		installLinkRouting() {
			DOM.viewLayer.addEventListener('click', onViewLayerClick);
		},

		// Opens the file named in the URL hash, if any.
		openFromHash() {
			const hash = window.location.hash.substring(1);
			if (hash) openTarget(Target.decode(hash));
		},
	};
});
