// Remote synchronization, always explicit: refresh the file list, pull or push one file.
define('actions/sync',
	['model/config', 'storage/notesDb', 'remote/sync', 'lib/encoding', 'lib/dom', 'lib/fileTypes', 'lib/tabChannel', 'resources',
	 'ui/refs', 'ui/editor', 'ui/fileList', 'ui/status', 'actions/merge'],
	(Config, DBService, SyncService, Encoding, Dom, FileTypes, Tabs, R,
	 DOM, Editor, FileList, Status, Merge) => ({

	async refreshTree() {
		try {
			Status.show('Refreshing file list remotely...');
			const treeData = await SyncService.getTree();

			// FIX: Keep both blobs and folders so they enter IndexedDB
			const files = treeData.tree.filter(item => item.type === 'blob' || item.type === 'folder');

			for (const file of files) {
				let localNote = await DBService.get(file.path);
				const isFolder = file.type === 'folder';

				if (!localNote) {
					await DBService.put({
						filename: file.path,
						content: isFolder ? null : '', // Folders don't need content payloads
						last_synced_sha: null,
						remote_sha: file.sha,
						is_dirty: false,
						is_folder: isFolder // Explicitly flag it for the router
					});
				} else {
					localNote.remote_sha = file.sha;
					localNote.is_folder = isFolder;
					await DBService.put(localNote);
				}
			}
			Status.show('File list updated.');
			Tabs.post({ type: Tabs.SIDEBAR_REFRESH });
			FileList.render(DOM.searchBar.value, false);
		} catch (err) {
			Status.show(`Refresh failed: ${err.message}`, true);
		}
	},

	async pull() {
		const filename = Editor.currentFilename();
		if (!filename) return;

		try {
			let localNote = await DBService.get(filename);
			Status.show(`Pulling ${filename}...`);

			// Must agree with the providers, which return a Blob for every non-text file.
			const isBinary = FileTypes.isBinaryFile(filename);
			const fileResponse = await SyncService.getFile(filename);

			if (!localNote) {
				localNote = { filename, content: '', last_synced_sha: null, remote_sha: null, is_dirty: false };
			}

			if (isBinary) {
				localNote.content = fileResponse;
				localNote.is_dirty = false;
				localNote.last_synced_sha = localNote.remote_sha;
			} else {
				const remoteContent = Encoding.atou(fileResponse.content);
				if (localNote.is_dirty && localNote.content !== remoteContent) {
					const choice = prompt(`Conflict in ${filename}!\nd: Insert Diff markers\nw: Overwrite local with remote\ni: Ignore remote`, "d");
					if (choice === null) return Status.show("Pull cancelled.");

					if (choice === "w") {
						localNote.content = remoteContent;
						localNote.is_dirty = false;
					} else if (choice === "i") {
						localNote.is_dirty = true;
					} else {
						Status.show(`Loading diff engine...`);
						try {
							await Dom.loadResource(R.jsdiff);
						} catch (err) {
							return Status.show(`Error: Failed to load diff engine. Merge cancelled.`, true);
						}

						Status.show(`Injecting merge markers...`, true);
						localNote.content = typeof Diff !== 'undefined'
							? Merge.diffMarkers(Diff, remoteContent, localNote.content)
							: Merge.wholeFileMarkers(remoteContent, localNote.content);
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
			Editor.activate(filename, localNote.content);
			Status.show(`Successfully pulled ${filename}.`);
			Tabs.post({ type: Tabs.SIDEBAR_REFRESH });
			FileList.render(DOM.searchBar.value, false);
		} catch (err) {
			Status.show(`Pull failed: ${err.message}`, true);
		}
	},

	async push() {
		const filename = Editor.currentFilename();
		if (!filename) return;

		try {
			const note = await DBService.get(filename);
			if (!note || !note.is_dirty) return Status.show(`${filename} is already up to date.`);

			let commitMsg = null;
			const kc = Config.activeKeychain;

			// Guard: Only prompt if the toggle is on AND the provider is not Dropbox
			if (Config.activeWorkspace.askForCommitMsg && kc && kc.provider !== 'dropbox') {
				const userMsg = prompt(`Enter commit message for ${filename}:`);
				if (userMsg == null) return Status.show("Push cancelled.");
				if (userMsg.trim()) commitMsg = userMsg.trim();
			}

			Status.show(`Pushing ${filename}...`);

			let base64Content;

			if (typeof note.content === 'object' && note.content !== null) {
				base64Content = await Encoding.blobToBase64(note.content);
			} else {
				base64Content = Encoding.utoa(String(note.content));
			}

			const responseData = await SyncService.putFile(filename, base64Content, note.last_synced_sha, commitMsg);

			note.last_synced_sha = responseData.content.sha;
			note.remote_sha = responseData.content.sha;
			note.is_dirty = false;
			await DBService.put(note);

			Status.show(`Successfully pushed ${filename}.`);
			Tabs.post({ type: Tabs.SIDEBAR_REFRESH });
			FileList.render(DOM.searchBar.value, false);
		} catch (err) {
			Status.show(`Push error: ${err.message}`, true);
		}
	},
}));
