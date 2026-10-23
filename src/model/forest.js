// The workspace forest: workspaces that share a remote origin form a tree,
// and each workspace is a mount point (rootDir) within it. Everything here
// is derived from model/config on demand, never stored.
define('model/forest', ['model/config', 'lib/path'], (Config, Path) => {
	const { cleanPath } = Path;

	// Computes a stable string key (the "tree signature") that identifies which
	// remote origin a workspace is rooted in. All workspaces sharing the same
	// signature belong to the same logical file tree ("forest tree").
	const computeTreeSig = (ws, kc) => {
		const provider = kc ? kc.provider : 'github';
		if (provider === 'dropbox') return `dropbox|${ws.keychainId}`;
		if (provider === 'remotestorage') return `remotestorage|${(ws.host || '').trim().replace(/\/+$/, '')}`;
		return `github|${ws.host}|${ws.owner}|${ws.repo}|${ws.branch}`;
	};

	const Forest = {
		computeTreeSig,

		activeTreeSignature() {
			const ws = Config.activeWorkspace;
			if (!ws) return null;
			return computeTreeSig(ws, Config.activeKeychain);
		},

		// { treeSignature: [workspaceId, ...] }
		workspaceTrees() {
			const trees = {};

			for (const [id, ws] of Object.entries(Config.workspaces)) {
				const kc = Config.keychains[ws.keychainId];
				const sig = computeTreeSig(ws, kc);
				if (!trees[sig]) trees[sig] = [];
				trees[sig].push(id);
			}

			// Sort each tree's workspace IDs by rootDir length (deepest paths first)
			// so the Router always evaluates the most specific "Best Fit" workspace first.
			for (const sig in trees) {
				trees[sig].sort((a, b) => {
					const rootA = cleanPath(Config.workspaces[a].rootDir);
					const rootB = cleanPath(Config.workspaces[b].rootDir);
					return rootB.length - rootA.length;
				});
			}

			return trees;
		},

		// Pins are stored at the tree (forest) level.
		activePins() {
			const sig = this.activeTreeSignature();
			return sig && Config.treePins[sig] ? Config.treePins[sig] : [];
		},

		// The workspace ids of one tree, deepest mount first (default: the active tree).
		_treeIds(sig = this.activeTreeSignature()) {
			if (!sig) return null;
			return this.workspaceTrees()[sig] || [];
		},

		// 1. Local -> Global: Gets the absolute forest path for a local file
		getAbsolutePath(workspaceId, filename) {
			const ws = Config.workspaces[workspaceId];
			if (!ws) return cleanPath(filename);

			const cleanRoot = cleanPath(ws.rootDir);
			const cleanFile = cleanPath(filename);
			return [cleanRoot, cleanFile].filter(Boolean).join('/');
		},

		// 2. Global -> Local: Slices a forest path down for a specific workspace.
		// Null if the path is outside the workspace's root.
		getRelativePath(workspaceId, absolutePath) {
			const targetRoot = cleanPath(Config.workspaces[workspaceId].rootDir);
			if (!targetRoot) return absolutePath;
			if (absolutePath === targetRoot) return '';
			if (absolutePath.startsWith(targetRoot + '/')) return absolutePath.substring(targetRoot.length + 1);
			return null;
		},

		// 3. The Router: Finds the deepest workspace mounted for an absolute path,
		// in the active tree or the one named by `sig`
		resolveBestFit(absolutePath, sig) {
			const treeWsIds = this._treeIds(sig);
			if (!treeWsIds) return null;

			return treeWsIds.find(id => {
				const targetRoot = cleanPath(Config.workspaces[id].rootDir);
				return targetRoot === '' || absolutePath === targetRoot || absolutePath.startsWith(targetRoot + '/');
			});
		},

		// 4. The Mapper: Finds sub-workspaces that should appear as folders locally
		getVirtualMounts() {
			const treeWsIds = this._treeIds();
			if (!treeWsIds) return [];

			const currentRoot = cleanPath(Config.activeWorkspace.rootDir);
			const virtuals = [];

			treeWsIds.forEach(id => {
				if (id === Config.activeWorkspaceId) return;

				const targetRoot = cleanPath(Config.workspaces[id].rootDir);
				if (targetRoot && (currentRoot === '' || targetRoot.startsWith(currentRoot + '/'))) {
					const relativePath = currentRoot === '' ? targetRoot : targetRoot.substring(currentRoot.length + 1);
					virtuals.push(relativePath);
				}
			});

			return virtuals;
		},

		// 5. Exact Mount: Finds if a path is the explicit root of a sub-workspace
		getExactMount(absolutePath) {
			const treeWsIds = this._treeIds();
			if (!treeWsIds) return null;

			return treeWsIds.find(id => {
				const targetRoot = cleanPath(Config.workspaces[id].rootDir);
				return targetRoot === absolutePath;
			});
		},

		// 6. Leaf constraint: another workspace of the same tree is mounted strictly
		// below this one (an equal root is a sibling, not a child). A deep listing
		// would then also cache that mount's files, so the workspace must be shallow.
		hasMountsBelow(workspaceId) {
			const ws = Config.workspaces[workspaceId];
			const sig = computeTreeSig(ws, Config.keychains[ws.keychainId]);
			const root = cleanPath(ws.rootDir);
			return (this.workspaceTrees()[sig] || []).some(id => {
				const childRoot = cleanPath(Config.workspaces[id].rootDir);
				return id !== workspaceId && childRoot !== root && (root === '' || childRoot.startsWith(root + '/'));
			});
		},

		// 7. Navigation: Finds the nearest parent workspace for the current view
		getParentWorkspace() {
			const absolutePath = this.getAbsolutePath(Config.activeWorkspaceId, '');
			if (!absolutePath) return null; // We are at the absolute root

			// By finding the best fit for our own parent directory, we find the immediate mount point above us
			const parentDir = absolutePath.includes('/') ? absolutePath.substring(0, absolutePath.lastIndexOf('/')) : '';
			return this.resolveBestFit(parentDir);
		},
	};

	return Forest;
});
