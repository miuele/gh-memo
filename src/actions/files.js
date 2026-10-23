// Local file operations: open (including mount and symlink redirection),
// create, upload, autosave, delete and export.
define('actions/files',
	['model/config', 'model/forest', 'model/symlink', 'model/target', 'storage/notesDb', 'remote/sync', 'lib/tabChannel', 'lib/fileTypes',
	 'ui/refs', 'ui/editor', 'ui/fileList', 'ui/sidebar', 'ui/status', 'actions/workspaces'],
	(Config, Forest, Symlink, Target, DBService, SyncService, Tabs, FileTypes,
	 DOM, Editor, FileList, Sidebar, Status, Workspaces) => {

	// The debounced autosave: { filename, dbName, content } waiting for typingTimer.
	let typingTimer = null;
	let pendingEdit = null;
	// Chain of autosave writes, so flushes complete in order.
	let writing = Promise.resolve();
	// When on, .symlink files open in the editor instead of being followed.
	let isSymlinkEditMode = false;

	// Saves one edit into the file and workspace it was typed in. A note that
	// is gone (deleted, cache cleared) is not recreated.
	const saveEdit = async ({ filename, dbName, content }) => {
		try {
			const note = await DBService.get(filename, dbName);
			if (!note || note.content === content) return;
			note.content = content;
			note.is_dirty = true;
			await DBService.put(note, dbName);

			Tabs.post({ type: Tabs.LOCAL_EDIT, dbName, filename });
			if (dbName === DBService.dbName) FileList.render(DOM.searchBar.value, false);
		} catch (err) {
			Status.show(`Couldn't save ${filename}: ${err.message}`, true);
		}
	};

	const Files = {
		isSymlinkEditMode: () => isSymlinkEditMode,
		setSymlinkEditMode(value) { isSymlinkEditMode = value; },

		// `hops` counts symlinks followed on the way here, to stop a loop.
		async open(filename, skipHistory = false, hops = 0) {
			await Files.flushPendingEdit();
			const absolutePath = Forest.getAbsolutePath(Config.activeWorkspaceId, filename);
			const matchedId = Forest.getExactMount(absolutePath);

			if (matchedId) {
				return Workspaces.switchTo(matchedId); // Teleport!
			}
			// ----------------------------------

			let note;
			try {
				note = await DBService.get(filename);
			} catch (err) {
				// Most likely a wedged IndexedDB connection (see DBService.DB_TIMEOUT_MS)
				// — without this, a click here would previously do nothing at all.
				return Status.show(`Couldn't open ${filename}: ${err.message}`, true);
			}
			if (!note) return Status.show(`${filename} is not stored locally.`, true);

			// --- 2. UNMOUNTED FOLDER INTERCEPTOR ---
			if (note.is_folder) {
				return Status.show(`Cannot open directory: No sub-workspace is mounted for '/${absolutePath}'.`, true);
			}
			// ---------------------------------------

			// --- 3. THE SYMLINK INTERCEPTOR ---
			if (filename.endsWith('.symlink') && !isSymlinkEditMode) {
				const target = Symlink.target(note.content);
				if (!target) return Status.show(`⚠️ ${filename} names no target.`, true);
				if (hops >= 8) return Status.show(`❌ Too many symlinks in a row at ${filename}.`, true);

				const found = Target.resolve(target, { from: { sig: Forest.activeTreeSignature(), path: absolutePath } });
				if (found.error) return Status.show(`❌ ${found.error}`, true);
				if (found.workspaceId !== Config.activeWorkspaceId || !found.filename) Workspaces.switchTo(found.workspaceId, skipHistory);
				if (found.filename) return Files.open(found.filename, skipHistory, hops + 1);
				return;
			}
			// ----------------------------------

			// Standard Editor Boot Sequence
			if (!skipHistory) {
			    history.pushState(
			        { workspaceId: Config.activeWorkspaceId, filename: filename },
			        null,
			        '#' + Target.encode(Target.forWorkspace(Config.activeWorkspaceId, filename))
			    );
			}

			if (window.innerWidth < 768) {
				Sidebar.collapse();
			}

			Editor.activate(filename, note.content);
			FileList.render(DOM.searchBar.value, false);
		},

		async create() {
			let filename = prompt('Enter filename (e.g., folder/draft.txt):');
			if (!filename) return;
			if (!filename.includes('.')) filename += '.txt';

			if (await DBService.get(filename)) return alert('File already exists locally.');

			await DBService.put({ filename, content: '', last_synced_sha: null, remote_sha: null, is_dirty: true });
			Tabs.post({ type: Tabs.SIDEBAR_REFRESH });
			Files.open(filename);
		},

		async handleUpload(event) {
			const file = event.target.files[0];
			if (!file) return;

			event.target.value = '';

			if (file.size > SyncService.fileUploadSizeLimit()) {
				return Status.show('File is too large.', true);
			}

			let filename = prompt('Confirm or rename file path (e.g., archive.zip):', file.name);
			if (!filename) return;

			const existing = await DBService.get(filename);
			if (existing && !confirm(`Overwrite existing local file "${filename}"?`)) return;

			const isText = FileTypes.isTextFile(filename);
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

			Status.show(`Successfully imported ${filename}.`);
			Tabs.post({ type: Tabs.SIDEBAR_REFRESH });
			Files.open(filename);
		},

		// Saves a pasted image straight into the local cache, without opening it.
		async savePastedImage(blob) {
			const ext = blob.type.split('/')[1] || 'png';
			let filename = prompt('Upload image directly to repository:', `images/image.${ext}`);

			if (!filename) {
				Status.show('Image upload cancelled.');
				return;
			}

			if (!filename.includes('.')) filename += `.${ext}`;

			Status.show(`Saving ${filename}...`);

			await DBService.put({
				filename: filename,
				content: blob,
				last_synced_sha: null,
				remote_sha: null,
				is_dirty: true
			});

			// Only update the file tree, do not touch the editor
			Tabs.post({ type: Tabs.SIDEBAR_REFRESH });
			Status.show(`Successfully saved ${filename}.`);
		},

		// Debounced autosave from the editor. The target file and database are
		// captured now, not when the timer fires: by then the user may have
		// opened another file or switched workspace.
		handleTyping(newContent) {
			const filename = Editor.currentFilename();
			if (!filename) return;
			const dbName = DBService.dbName;

			if (pendingEdit && (pendingEdit.filename !== filename || pendingEdit.dbName !== dbName)) {
				Files.flushPendingEdit();
			}
			clearTimeout(typingTimer);
			pendingEdit = { filename, dbName, content: newContent };
			typingTimer = setTimeout(() => Files.flushPendingEdit(), 500);
		},

		// Writes the debounced edit now, if there is one. Anything that reads a
		// note back, replaces the editor or leaves the page awaits this first.
		// Resolves once every write started so far has finished.
		flushPendingEdit() {
			clearTimeout(typingTimer);
			const edit = pendingEdit;
			pendingEdit = null;
			if (edit) writing = writing.then(() => saveEdit(edit));
			return writing;
		},

		async remove() {
			const filename = Editor.currentFilename();
			if (!filename) return;
			await Files.flushPendingEdit();
			const note = await DBService.get(filename);
			if (!note) return;

			const msg = note.last_synced_sha ? `Delete ${filename} from local AND remote?` : `Delete ${filename} locally?`;
			if (!confirm(msg)) return;

			try {
				if (note.last_synced_sha) {
					Status.show(`Deleting ${filename} remotely...`);
					await SyncService.deleteFile(filename, note.last_synced_sha);
				}
				await DBService.delete(filename);
				Editor.reset();
				history.replaceState(null, null, window.location.pathname);
				Tabs.post({ type: Tabs.SIDEBAR_REFRESH });
				FileList.render();
				Status.show('File deleted successfully.');
			} catch (err) {
				Status.show(`Error: ${err.message}`, true);
			}
		},

		// Exports the current file to the user's local disk via a browser download.
		// This is intentionally independent of any remote provider — it works even
		// for a workspace with no keychain configured at all, since it only reads
		// from the local IndexedDB cache (plus whatever's live in the editor).
		async exportFile() {
			const filename = Editor.currentFilename();
			if (!filename) return;

			try {
				await Files.flushPendingEdit();
				const note = await DBService.get(filename);
				if (!note) return Status.show('Nothing to export: file not found locally.', true);

				// The flush above saved the last debounced edit, but a keystroke
				// can still land after it. Text-based plugins (Text/Markdown) expose their live
				// textarea; prefer that. Read-only viewers (Image/PDF/Unsupported)
				// have no edit buffer, so note.content — the Blob itself — is
				// already authoritative for them.
				const plugin = Editor.activePlugin();
				const liveContent = (plugin && plugin.textarea) ? plugin.textarea.value : note.content;

				const blob = liveContent instanceof Blob
					? liveContent
					: new Blob([liveContent ?? ''], { type: 'text/plain;charset=utf-8' });

				// Use only the basename for the download — the full VFS path (e.g.
				// "docs/notes.md") isn't a valid target for a flat Downloads folder.
				const basename = filename.includes('/') ? filename.substring(filename.lastIndexOf('/') + 1) : filename;

				const url = URL.createObjectURL(blob);
				const link = document.createElement('a');
				link.href = url;
				link.download = basename;
				document.body.appendChild(link);
				link.click();
				link.remove();

				// Revoke on a delay rather than immediately — some browsers kick off
				// the download asynchronously and a same-tick revoke can race it.
				setTimeout(() => URL.revokeObjectURL(url), 1000);

				Status.show(`Exported ${basename}.`);
			} catch (err) {
				Status.show(`Export failed: ${err.message}`, true);
			}
		},
	};

	return Files;
});
