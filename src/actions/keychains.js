define('actions/keychains', ['model/config', 'ui/settings'], (Config, SettingsView) => ({
	create() {
		const name = prompt('Enter keychain name (e.g., Personal GitHub, Work Dropbox):');
		if (!name) return;

		const id = 'kc_' + Date.now();
		Config.keychains[id] = {
			name: name,
			provider: 'github', // default
			token: '',
			appKey: '',
			refreshToken: ''
		};

		Config.saveKeychains();
		SettingsView.render();
	},

	remove(id) {
		// Prevent deletion if workspaces are relying on it
		const inUse = Object.values(Config.workspaces).some(ws => ws.keychainId === id);
		if (inUse) return alert("Cannot delete: This keychain is currently linked to a workspace.");

		if (!confirm(`Delete keychain "${Config.keychains[id].name}"?`)) return;

		delete Config.keychains[id];
		Config.saveKeychains();
		SettingsView.render();
	},
}));
