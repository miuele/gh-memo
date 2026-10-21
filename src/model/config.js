// Persisted configuration: keychains (credentials), workspaces (mount points),
// pins and the active workspace. This is the only module that touches
// localStorage; everything else reads the fields and calls a save*() method.
define('model/config', [], () => {
	const KEYS = {
		keychains: 'notes_keychains',
		workspaces: 'notes_workspaces',
		activeWorkspace: 'notes_active_workspace',
		treePins: 'notes_tree_pins',
	};
	const readJson = (key) => JSON.parse(localStorage.getItem(key) || '{}');
	const writeJson = (key, value) => localStorage.setItem(key, JSON.stringify(value));

	return {
		// Tier 1: The Credentials
		keychains: {},
		// Tier 2: The Mount Points
		workspaces: {},
		activeWorkspaceId: null,
		// Pins, keyed by tree signature (see model/forest)
		treePins: {},

		load() {
			this.keychains = readJson(KEYS.keychains);
			this.workspaces = readJson(KEYS.workspaces);
			this.activeWorkspaceId = localStorage.getItem(KEYS.activeWorkspace) || null;
			this.treePins = readJson(KEYS.treePins);
		},

		saveKeychains() { writeJson(KEYS.keychains, this.keychains); },
		saveWorkspaces() { writeJson(KEYS.workspaces, this.workspaces); },
		savePins() { writeJson(KEYS.treePins, this.treePins); },
		setActiveWorkspace(id) {
			this.activeWorkspaceId = id;
			localStorage.setItem(KEYS.activeWorkspace, id);
		},

		// Context helpers (dynamically resolved, never duplicated)
		get activeWorkspace() { return this.workspaces[this.activeWorkspaceId] || null; },
		get activeKeychain() {
			return this.activeWorkspace ? this.keychains[this.activeWorkspace.keychainId] : null;
		},
	};
});
