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

    // --- WORKSPACE FOREST LOGIC ---
    get activeTreeSignature() {
        const ws = this.activeWorkspace;
        if (!ws) return null;
        const kc = this.activeKeychain;
        const provider = kc ? kc.provider : 'github';
        
        // Dropbox instances are isolated strictly by the account token they use
        if (provider === 'dropbox') return `dropbox|${ws.keychainId}`;
        
        // Git instances are isolated by their absolute remote origin
        return `github|${ws.host}|${ws.owner}|${ws.repo}|${ws.branch}`;
    },

    get workspaceTrees() {
        const trees = {};
        
        for (const [id, ws] of Object.entries(this.workspaces)) {
            const kc = this.keychains[ws.keychainId];
            const provider = kc ? kc.provider : 'github';
            
            let sig;
            if (provider === 'dropbox') sig = `dropbox|${ws.keychainId}`;
            else sig = `github|${ws.host}|${ws.owner}|${ws.repo}|${ws.branch}`;
            
            if (!trees[sig]) trees[sig] = [];
            trees[sig].push(id);
        }

        // Sort each tree's workspace IDs by rootDir length (Deepest paths first)
        // This guarantees the Router will evaluate the most specific "Best Fit" workspace first
        for (const sig in trees) {
            trees[sig].sort((a, b) => {
                const rootA = (this.workspaces[a].rootDir || '').replace(/(^\/+|\/+$)/g, '');
                const rootB = (this.workspaces[b].rootDir || '').replace(/(^\/+|\/+$)/g, '');
                return rootB.length - rootA.length; 
            });
        }

        return trees;
    },
    // ------------------------------
    
	// --- PINS (FOREST LEVEL) ---
    treePins: JSON.parse(localStorage.getItem('notes_tree_pins') || '{}'),
    get activePins() {
        const sig = this.activeTreeSignature;
        return sig && this.treePins[sig] ? this.treePins[sig] : [];
    },
    // ---------------------------
    isViewMode: false,
    currentFilename: null,
    typingTimer: null,
    activePlugin: null,
    isFrozen: false,
    syncChannel: new BroadcastChannel('github_notes_sync'),
    isSymlinkEditMode: false,
};

const VFS = {
	// 1. Local -> Global: Gets the absolute forest path for a local file
	getAbsolutePath(workspaceId, filename) {
		const ws = AppState.workspaces[workspaceId];
		if (!ws) return (filename || '').replace(/(^\/+|\/+$)/g, '');

		const cleanRoot = (ws.rootDir || '').replace(/(^\/+|\/+$)/g, '');
		const cleanFile = (filename || '').replace(/(^\/+|\/+$)/g, '');
		return [cleanRoot, cleanFile].filter(Boolean).join('/');
	},

	// 2. Global -> Local: Slices a forest path down for a specific workspace
	getRelativePath(workspaceId, absolutePath) {
		const targetRoot = (AppState.workspaces[workspaceId].rootDir || '').replace(/(^\/+|\/+$)/g, '');
		if (targetRoot && absolutePath.startsWith(targetRoot)) {
			return absolutePath.substring(targetRoot.length).replace(/^\//, '');
		}
		return absolutePath;
	},

	// 3. The Router: Finds the deepest workspace mounted for an absolute path
	resolveBestFit(absolutePath) {
		const sig = AppState.activeTreeSignature;
		if (!sig) return null;

		const treeWsIds = AppState.workspaceTrees[sig] || [];
		return treeWsIds.find(id => {
			const targetRoot = (AppState.workspaces[id].rootDir || '').replace(/(^\/+|\/+$)/g, '');
			return targetRoot === '' || absolutePath === targetRoot || absolutePath.startsWith(targetRoot + '/');
		});
	},

	// 4. The Mapper: Finds sub-workspaces that should appear as folders locally
	getVirtualMounts() {
		const sig = AppState.activeTreeSignature;
		if (!sig) return [];

		const treeWsIds = AppState.workspaceTrees[sig] || [];
		const currentRoot = (AppState.activeWorkspace.rootDir || '').replace(/(^\/+|\/+$)/g, '');
		const virtuals = [];

		treeWsIds.forEach(id => {
			if (id === AppState.activeWorkspaceId) return;

			const targetRoot = (AppState.workspaces[id].rootDir || '').replace(/(^\/+|\/+$)/g, '');
			if (targetRoot && (currentRoot === '' || targetRoot.startsWith(currentRoot + '/'))) {
				const relativePath = currentRoot === '' ? targetRoot : targetRoot.substring(currentRoot.length + 1);
				virtuals.push(relativePath);
			}
		});

		return virtuals;
	},

	// 5. Exact Mount: Finds if a path is the explicit root of a sub-workspace
	getExactMount(absolutePath) {
		const sig = AppState.activeTreeSignature;
		if (!sig) return null;
		const treeWsIds = AppState.workspaceTrees[sig] || [];
		return treeWsIds.find(id => {
			const targetRoot = (AppState.workspaces[id].rootDir || '').replace(/(^\/+|\/+$)/g, '');
			return targetRoot === absolutePath;
		});
	},

	// 6. Navigation: Finds the nearest parent workspace for the current view
	getParentWorkspace() {
		const absolutePath = this.getAbsolutePath(AppState.activeWorkspaceId, '');
		if (!absolutePath) return null; // We are at the absolute root

		// By finding the best fit for our own parent directory, we find the immediate mount point above us
		const parentDir = absolutePath.includes('/') ? absolutePath.substring(0, absolutePath.lastIndexOf('/')) : '';
		return this.resolveBestFit(parentDir);
	}
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

