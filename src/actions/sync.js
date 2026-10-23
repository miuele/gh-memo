// Remote synchronization, always explicit: refresh the file list, pull or push one file.
define('actions/sync',
	['model/config', 'storage/notesDb', 'remote/sync', 'lib/encoding', 'lib/dom', 'lib/fileTypes', 'lib/tabChannel', 'resources',
	 'ui/refs', 'ui/editor', 'ui/fileList', 'ui/status', 'actions/merge', 'actions/files'],
	(Config, DBService, SyncService, Encoding, Dom, FileTypes, Tabs, R,
	 DOM, Editor, FileList, Status, Merge, Files) => {

	// Note contents are strings, or Blobs for binary files (compared by bytes).
	const sameContent = async (a, b) => {
		if (!(a instanceof Blob) || !(b instanceof Blob)) return a === b;
		if (a.size !== b.size || a.type !== b.type) return false;
		const [x, y] = await Promise.all([a.arrayBuffer(), b.arrayBuffer()]).then(bs => bs.map(buf => new Uint8Array(buf)));
		return x.every((byte, i) => byte === y[i]);
	};

	// Notes the remote listing covers but no longer contains (D5). A shallow
	// listing covers only the top level. Notes never seen remotely are
	// local-only already and are left alone.
	const missingFromTree = (notes, tree, shallow) => {
		const listed = new Set(tree.map(item => item.path));
		return notes.filter(note => note.remote_sha
			&& !listed.has(note.filename)
			&& !(shallow && note.filename.includes('/')));
	};

	// A missing note with nothing local (a placeholder Refresh created and
	// nobody pulled, or a folder entry) is dropped. Anything else becomes a
	// local-only file, which a push creates again.
	const holdsNothingLocal = (note) => note.is_folder || (!note.last_synced_sha && !note.is_dirty);

	// What a refresh writes, from the stored notes and the listing (pure, so it
	// can run inside one IndexedDB transaction: E5).
	//   - every listed file gets its remote sha, or a placeholder if not stored;
	//   - in a shallow workspace, nested notes are left over from a deep listing
	//     or a link, and under a mount they duplicate its files (D7): clean ones
	//     are dropped, edited ones kept;
	//   - notes the listing no longer has are handled as above (D5), unless the
	//     listing was truncated and can't tell.
	const planRefresh = (notes, files, { shallow, truncated }) => {
		const byName = new Map(notes.map(note => [note.filename, note]));
		const put = [];
		const drop = [];
		let nestedKept = 0;
		let nowLocalOnly = 0;

		for (const file of files) {
			const isFolder = file.type === 'folder';
			const note = byName.get(file.path);
			put.push(note
				? { ...note, remote_sha: file.sha, is_folder: isFolder }
				: { filename: file.path, content: isFolder ? null : '', last_synced_sha: null, remote_sha: file.sha, is_dirty: false, is_folder: isFolder });
		}

		if (shallow) {
			for (const note of notes.filter(n => n.filename.includes('/'))) {
				if (note.is_dirty && !note.is_folder) nestedKept++;
				else drop.push(note.filename);
			}
		}

		if (!truncated) {
			for (const note of missingFromTree(notes, files, shallow)) {
				if (holdsNothingLocal(note)) {
					drop.push(note.filename);
				} else {
					put.push({ ...note, remote_sha: null, last_synced_sha: null, is_dirty: true });
					nowLocalOnly++;
				}
			}
		}
		return { put, delete: drop, nestedKept, nowLocalOnly };
	};

	return {
		async refreshTree() {
			try {
				Status.show('Refreshing file list remotely...');
				// The listing is written to the workspace it was made for, even if
				// the user switches away during the network call.
				const { dbName, shallow } = Config.activeWorkspace;
				const treeData = await SyncService.getTree();
				// Keep both blobs and folders so they enter IndexedDB
				const files = treeData.tree.filter(item => item.type === 'blob' || item.type === 'folder');

				// Edits typed during the network call must be stored before the plan reads them.
				await Files.flushPendingEdit();
				const { delete: dropped, nestedKept, nowLocalOnly } = await DBService.rewriteAll(
					notes => planRefresh(notes, files, { shallow, truncated: treeData.truncated }), dbName);
				if (DBService.dbName === dbName && dropped.includes(Editor.currentFilename())) Editor.reset();

				const count = (n) => n === 1 ? '1 file' : `${n} files`;
				if (treeData.truncated) {
					Status.show('⚠️ File list incomplete: GitHub truncated this tree. Mount large sub-directories separately, or mark them Shallow.', true);
				} else {
					Status.show(['File list updated.',
						nowLocalOnly && `${count(nowLocalOnly)} deleted remotely ${nowLocalOnly === 1 ? 'is' : 'are'} now local-only.`,
						nestedKept && `Kept ${count(nestedKept)} in subfolders with unpushed edits.`,
					].filter(Boolean).join(' '));
				}
				Tabs.post({ type: Tabs.SIDEBAR_REFRESH });
				FileList.render(DOM.searchBar.value, false);
			} catch (err) {
				Status.show(`Refresh failed: ${err.message}`, true);
			}
		},

		// Pull and push read the note, wait on the network, then write it back.
		// The user can keep typing meanwhile, or switch file or workspace, so both
		// flush the pending autosave before and after the network call, write
		// back only into the workspace they started in, and decide from the note
		// as it is after the call, never from the snapshot taken before it.
		async pull() {
			const filename = Editor.currentFilename();
			if (!filename) return;
			const dbName = DBService.dbName;

			try {
				await Files.flushPendingEdit();
				Status.show(`Pulling ${filename}...`);

				// Must agree with the providers, whose content is a Blob for every non-text file.
				const isBinary = FileTypes.isBinaryFile(filename);
				const fileResponse = await SyncService.getFile(filename);

				await Files.flushPendingEdit();
				let localNote = await DBService.get(filename, dbName);
				if (!localNote) {
					localNote = { filename, content: '', last_synced_sha: null, remote_sha: null, is_dirty: false };
				}

				if (isBinary) {
					localNote.content = fileResponse.content;
					localNote.is_dirty = false;
					// Without a sha (GitHub without crypto.subtle), fall back to the listed one.
					const sha = fileResponse.sha || localNote.remote_sha;
					localNote.last_synced_sha = sha;
					localNote.remote_sha = sha;
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

							// Typing may have continued while the engine loaded.
							await Files.flushPendingEdit();
							localNote = (await DBService.get(filename, dbName)) || localNote;

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

				await DBService.put(localNote, dbName);
				// Only redraw the editor if it still shows this file.
				if (Editor.currentFilename() === filename && DBService.dbName === dbName) {
					Editor.activate(filename, localNote.content);
				}
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
			const dbName = DBService.dbName;

			try {
				await Files.flushPendingEdit();
				const note = await DBService.get(filename, dbName);
				if (!note || !note.is_dirty) return Status.show(`${filename} is already up to date.`);

				let commitMsg = null;
				const kc = Config.activeKeychain;

				// Guard: Only prompt if the toggle is on AND the provider is GitHub (the only one with commits)
				if (Config.activeWorkspace.askForCommitMsg && kc && (kc.provider || 'github') === 'github') {
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

				// The remote now holds what was pushed. Record its sha either way, but
				// the note stays dirty if it was edited (or deleted) during the upload.
				await Files.flushPendingEdit();
				const current = await DBService.get(filename, dbName);
				const pushedSha = responseData.content.sha;
				if (current) {
					const unchanged = await sameContent(current.content, note.content);
					current.last_synced_sha = pushedSha;
					current.remote_sha = pushedSha;
					if (unchanged) current.is_dirty = false;
					await DBService.put(current, dbName);
					Status.show(unchanged
						? `Successfully pushed ${filename}.`
						: `Pushed ${filename}. Edits made during the upload are not pushed yet.`);
				} else {
					Status.show(`Pushed ${filename}, which was deleted locally meanwhile.`);
				}

				Tabs.post({ type: Tabs.SIDEBAR_REFRESH });
				FileList.render(DOM.searchBar.value, false);
			} catch (err) {
				Status.show(`Push error: ${err.message}`, true);
			}
		},
	};
});
