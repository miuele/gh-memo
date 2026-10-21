// References to the fixed elements of index.html, filled in by init() once the DOM exists.
define('ui/refs', [], () => {
	const DOM = {
		init() {
			DOM.sidebar = document.getElementById('sidebar');
			DOM.fileInput = document.getElementById('file-upload');
			DOM.pinContainer = document.getElementById('pin-container');
			DOM.searchBar = document.getElementById('search-bar');
			DOM.fileList = document.getElementById('file-list');
			DOM.viewLayer = document.getElementById('view-layer');
			DOM.editLayer = document.getElementById('edit-layer');
			DOM.filenameLabel = document.getElementById('current-filename');
			DOM.saveBtn = document.getElementById('save-btn');
			DOM.pullBtn = document.getElementById('pull-btn');
			DOM.pushBtn = document.getElementById('push-btn');
			DOM.deleteBtn = document.getElementById('delete-btn');
			DOM.statusBar = document.getElementById('status-bar');
			DOM.viewToggle = document.getElementById('view-toggle');
			DOM.settingsPanel = document.getElementById('settings-panel');
			DOM.workspaceIndicator = document.getElementById('workspace-indicator');
		},
	};
	return DOM;
});
