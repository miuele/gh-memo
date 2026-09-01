// Computes a stable string key (the "tree signature") that identifies which
// remote origin a workspace is rooted in. All workspaces sharing the same
// signature belong to the same logical file tree ("forest tree").
// Extracted here to eliminate duplication between the activeTreeSignature
// getter and the workspaceTrees getter, both of which need the same logic.
function computeTreeSig(ws, kc) {
	const provider = kc ? kc.provider : 'github';
	if (provider === 'dropbox') return `dropbox|${ws.keychainId}`;
	return `github|${ws.host}|${ws.owner}|${ws.repo}|${ws.branch}`;
}

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
        return computeTreeSig(ws, this.activeKeychain);
    },

    get workspaceTrees() {
        const trees = {};

        for (const [id, ws] of Object.entries(this.workspaces)) {
            const kc = this.keychains[ws.keychainId];
            const sig = computeTreeSig(ws, kc);
            if (!trees[sig]) trees[sig] = [];
            trees[sig].push(id);
        }

        // Sort each tree's workspace IDs by rootDir length (deepest paths first)
        // so the Router always evaluates the most specific "Best Fit" workspace first.
        for (const sig in trees) {
            trees[sig].sort((a, b) => {
                const rootA = Utils.cleanPath(this.workspaces[a].rootDir);
                const rootB = Utils.cleanPath(this.workspaces[b].rootDir);
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
		if (!ws) return Utils.cleanPath(filename);

		const cleanRoot = Utils.cleanPath(ws.rootDir);
		const cleanFile = Utils.cleanPath(filename);
		return [cleanRoot, cleanFile].filter(Boolean).join('/');
	},

	// 2. Global -> Local: Slices a forest path down for a specific workspace
	getRelativePath(workspaceId, absolutePath) {
		const targetRoot = Utils.cleanPath(AppState.workspaces[workspaceId].rootDir);
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
			const targetRoot = Utils.cleanPath(AppState.workspaces[id].rootDir);
			return targetRoot === '' || absolutePath === targetRoot || absolutePath.startsWith(targetRoot + '/');
		});
	},

	// 4. The Mapper: Finds sub-workspaces that should appear as folders locally
	getVirtualMounts() {
		const sig = AppState.activeTreeSignature;
		if (!sig) return [];

		const treeWsIds = AppState.workspaceTrees[sig] || [];
		const currentRoot = Utils.cleanPath(AppState.activeWorkspace.rootDir);
		const virtuals = [];

		treeWsIds.forEach(id => {
			if (id === AppState.activeWorkspaceId) return;

			const targetRoot = Utils.cleanPath(AppState.workspaces[id].rootDir);
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
			const targetRoot = Utils.cleanPath(AppState.workspaces[id].rootDir);
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
	DOM.saveBtn = document.getElementById('save-btn');
	DOM.pullBtn = document.getElementById('pull-btn');
	DOM.pushBtn = document.getElementById('push-btn');
	DOM.deleteBtn = document.getElementById('delete-btn');
	DOM.statusBar = document.getElementById('status-bar');
	DOM.viewToggle = document.getElementById('view-toggle');
	DOM.settingsPanel = document.getElementById('settings-panel');
	DOM.workspaceIndicator = document.getElementById('workspace-indicator');
}
