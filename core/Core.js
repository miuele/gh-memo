const AppState = {
    renderId: 0,
    
    // Tier 1: The Credentials
    keychains: JSON.parse(localStorage.getItem('notes_keychains') || '{}'),
    
    // Tier 2: The Mount Points
    workspaces: JSON.parse(localStorage.getItem('notes_workspaces') || '{}'),
    activeWorkspaceId: localStorage.getItem('notes_active_workspace') || null,
    
    // Context Helpers (Dynamically resolved, never duplicated)
    get activeWorkspace() { return this.workspaces[this.activeWorkspaceId] || null; },
    get activeKeychain() { 
        return this.activeWorkspace ? this.keychains[this.activeWorkspace.keychainId] : null; 
    },
    
    pins: [],
    isViewMode: false,
    currentFilename: null,
    typingTimer: null,
    activePlugin: null,
    isFrozen: false,
    syncChannel: new BroadcastChannel('github_notes_sync'),
	isSymlinkEditMode: false,
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
	DOM.workspaceIndicator = document.getElementById('workspace-indicator');
}

