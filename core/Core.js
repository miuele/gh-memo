const AppState = {
	renderId: 0,
	// 1. The Master Directory
	profiles: JSON.parse(localStorage.getItem('notes_profiles') || '{}'),
	activeProfileId: localStorage.getItem('notes_active_profile') || null,

	// 2. The Current Context (Hydrated on boot)
	config: { host: '', token: '', owner: '', repo: '', branch: '' },
	pins: [],

	// UI State
	isViewMode: false,
	currentFilename: null,
	typingTimer: null,
	activePlugin: null,
	isFrozen: false,
	syncChannel: new BroadcastChannel('github_notes_sync')
};

const DOM = {};

function initDOM() {
	DOM.sidebar = document.getElementById('sidebar');
	DOM.fileInput = document.getElementById('file-upload');
	DOM.pinContainer = document.getElementById('pin-container');
	DOM.searchBar = document.getElementById('search-bar');
	DOM.fileList = document.getElementById('file-list');
	DOM.viewLayer = document.getElementById('view-layer');
	DOM.editLayer = document.getElementById('edit-layer');
	DOM.filenameLabel = document.getElementById('current-filename');
	DOM.pullBtn = document.getElementById('pull-btn');
	DOM.pushBtn = document.getElementById('push-btn');
	DOM.deleteBtn = document.getElementById('delete-btn');
	DOM.statusBar = document.getElementById('status-bar');
	DOM.viewToggle = document.getElementById('view-toggle');
	DOM.settingsPanel = document.getElementById('settings-panel');
}

