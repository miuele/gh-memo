// Pins live at the tree (forest) level as absolute paths, so a pin can open
// a file in whichever mount point currently covers it.
define('actions/pins',
	['model/config', 'model/forest', 'storage/notesDb', 'ui/refs', 'ui/editor', 'ui/pins', 'ui/fileList', 'ui/status', 'actions/files', 'actions/workspaces'],
	(Config, Forest, DBService, DOM, Editor, PinsView, FileList, Status, Files, Workspaces) => ({

	add() {
		const pinRelative = prompt('Enter a filename or directory path to pin (e.g., docs/ or README.md):', Editor.currentFilename() || '');
		if (!pinRelative) return;

		// 1. Compute the absolute path for Forest-level storage
		const absolutePath = Forest.getAbsolutePath(Config.activeWorkspaceId, pinRelative);

		// 2. Save it to the Tree Signature
		const sig = Forest.activeTreeSignature();
		if (!sig) return;

		if (!Config.treePins[sig]) Config.treePins[sig] = [];
		if (!Config.treePins[sig].includes(absolutePath)) {
			Config.treePins[sig].push(absolutePath);
			Config.savePins();
			PinsView.render();
		}
	},

	remove(absolutePath, event) {
		event.stopPropagation();
		const sig = Forest.activeTreeSignature();
		if (!sig || !Config.treePins[sig]) return;

		const index = Config.treePins[sig].indexOf(absolutePath);
		if (index > -1) {
			Config.treePins[sig].splice(index, 1);
			Config.savePins();
			PinsView.render();
		}
	},

	// Editing a tree's origin (keychain, host, owner, repo, branch) changes
	// its signature; carry its pins over instead of orphaning them. If the
	// new signature already has pins (two trees merging), the lists merge.
	rekey(oldSig, newSig) {
		const moved = Config.treePins[oldSig];
		if (oldSig === newSig || !moved) return;
		const existing = Config.treePins[newSig] || [];
		Config.treePins[newSig] = [...existing, ...moved.filter(p => !existing.includes(p))];
		delete Config.treePins[oldSig];
		Config.savePins();
		PinsView.render();
	},

	async open(absolutePath) {
		const matchedId = Forest.resolveBestFit(absolutePath);

		if (!matchedId) {
			return Status.show(`Cannot open pin: No workspace is mounted for this path.`, true);
		}

		// 2. Switch to the target environment
		if (matchedId !== Config.activeWorkspaceId) {
			Workspaces.switchTo(matchedId);
		}

		const relativePath = Forest.getRelativePath(matchedId, absolutePath);
		// 4. Open the file (or directory)
		if (relativePath) {
			const note = await DBService.get(relativePath);
			if (note) {
				Files.open(relativePath);
			} else {
				// Fallback: Dump it in the search bar if it hasn't been pulled locally yet
				DOM.searchBar.value = relativePath;
				FileList.render(relativePath, false);
			}
		}
	},
}));
