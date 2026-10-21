define('app/shortcuts', ['ui/refs', 'ui/editor', 'ui/status', 'actions/sync'], (DOM, Editor, Status, Sync) => ({
	install() {
		document.addEventListener('keydown', (e) => {
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
				e.preventDefault();
				Editor.currentFilename() ? Sync.push() : Status.show("No file open to push.", true);
			}
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
				e.preventDefault();
				DOM.searchBar.focus();
				DOM.searchBar.select();
			}
			if (e.altKey && e.key === 'ArrowDown') {
				e.preventDefault();
				Editor.currentFilename() ? Sync.pull() : Status.show("No file open to pull.", true);
			}
			if (e.altKey && e.key.toLowerCase() === 'r') {
				e.preventDefault();
				Sync.refreshTree();
			}
			if (e.altKey && e.key === ' ') {
				Editor.toggleViewMode();
			}
		});
	},
}));
