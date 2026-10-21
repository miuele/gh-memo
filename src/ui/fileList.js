// The sidebar file list, including virtual mount folders, the "../" entry
// and search (filename filter, or content search with match counts).
define('ui/fileList', ['ui/refs', 'ui/editor', 'lib/dom', 'storage/notesDb', 'model/forest'], (DOM, Editor, Dom, DBService, Forest) => {
	const { h } = Dom;
	let handlers = { open() {}, goUp() {} };
	let renderId = 0;

	// Derives the status icon for a file-list entry purely from its note state.
	const getFileIcon = (note) => {
		const isDirty = note.is_dirty;
		const localOnly = !note.remote_sha
		const hasRemoteUpdate = note.remote_sha && note.remote_sha !== note.last_synced_sha;
		if (note.is_folder) return note.is_mount_point ? '🗂️' : '📁';
		/* if (note.filename.endsWith('.symlink')) return '🔗'; */
		if (isDirty && hasRemoteUpdate) return '🟡⬇️';
		if (localOnly) return '';
		if (isDirty) return '🟡';
		if (hasRemoteUpdate) return '⬇️';
		return '🟢';
	};

	// Appends a trailing slash to folder entries so the type is visually unambiguous.
	const getDisplayName = (note) => note.is_folder ? note.filename + '/' : note.filename;

	// Filters and orders notes for display. Pure: mutates only note.matchCount.
	const filterNotes = (notes, searchTerm, deepSearch) => {
		const term = searchTerm.toLowerCase();

		if (term) {
			if (deepSearch) {
				notes.forEach(note => {
					// Guard against binary blobs
					if (typeof note.content === 'string') {
						const content = note.content.toLowerCase();
						note.matchCount = content.split(term).length - 1;
					} else {
						note.matchCount = 0;
					}
				});
				notes = notes.filter(n => n.matchCount > 0 || n.filename.toLowerCase().includes(term));
				notes.sort((a, b) => (b.matchCount || 0) - (a.matchCount || 0));
			} else {
				notes = notes.filter(n => n.filename.toLowerCase().includes(term));
			}
		} else {
			notes.sort((a, b) => a.filename.localeCompare(b.filename));
		}
		return notes;
	};

	return {
		// handlers: { open(filename), goUp(workspaceId) }
		bind(hs) { handlers = hs; },

		getFileIcon,
		filterNotes,

		async render(searchTerm = '', deepSearch = false) {
			// 1. Grab a ticket for this specific render request
			const currentRenderId = ++renderId;

			let notes = await DBService.getAll();

			// --- VIRTUAL MOUNT POINT INJECTION ---
			const virtualMounts = Forest.getVirtualMounts();
			virtualMounts.forEach(relativePath => {
				if (!notes.find(n => n.filename === relativePath)) {
					notes.push({ filename: relativePath, is_folder: true, is_mount_point: true, is_dirty: false, matchCount: 0 });
				} else {
					notes.find(n => n.filename === relativePath).is_mount_point = true;
				}
			});
			// -------------------------------------

			// 2. If another search started while we were waiting for the DB, abort this one!
			if (currentRenderId !== renderId) return;

			DOM.fileList.replaceChildren();
			notes = filterNotes(notes, searchTerm, deepSearch);

			// --- PARENT WORKSPACE NAVIGATION BUTTON ---
			// Only show the "Go Up" button if we are not currently searching
			if (!searchTerm) {
				const parentId = Forest.getParentWorkspace();
				if (parentId) {
					const li = h('li', {
						class: 'file-item parent-nav',
						onclick: () => handlers.goUp(parentId)
					}, h('span', {}, '🔙 ../'));

					DOM.fileList.appendChild(li);
				}
			}
			// ------------------------------------------

			notes.forEach(note => {
				const li = h('li', {
					class: 'file-item' + (note.filename === Editor.currentFilename() ? ' active' : ''),
					onclick: () => handlers.open(note.filename)
				}, h('span', {}, getFileIcon(note) + ' ' + getDisplayName(note)));

				if (deepSearch && note.matchCount) {
					li.appendChild(h('span', { class: 'match-count' }, note.matchCount + ' match' + (note.matchCount > 1 ? 'es' : '')));
				}

				DOM.fileList.appendChild(li);
			});
		},
	};
});
