// The active-workspace label at the top of the sidebar.
define('ui/indicator', ['ui/refs', 'model/config'], (DOM, Config) => ({
	update() {
		if (!DOM.workspaceIndicator) return;

		const ws = Config.activeWorkspace;
		if (!ws) {
			DOM.workspaceIndicator.textContent = '';
			return;
		}

		DOM.workspaceIndicator.textContent = `📁 ${ws.name.toUpperCase()}`;

		// Build a rich hover tooltip
		const kc = Config.keychains[ws.keychainId];
		const providerStr = kc ? kc.provider : 'unknown';

		if (providerStr === 'github') {
			DOM.workspaceIndicator.title = `Provider: GitHub\nRepo: ${ws.owner}/${ws.repo}\nBranch: ${ws.branch}\nRoot: ${ws.rootDir || '/'}`;
		} else {
			DOM.workspaceIndicator.title = `Provider: Dropbox\nRoot: ${ws.rootDir || '/'}`;
		}
	},
}));
