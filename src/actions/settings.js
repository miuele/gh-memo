define('actions/settings',
	['model/config', 'ui/refs', 'ui/editor', 'ui/settings', 'ui/sidebar', 'ui/status'],
	(Config, DOM, Editor, SettingsView, Sidebar, Status) => ({

	open() {
		Editor.reset();
		history.replaceState(null, null, window.location.pathname);

		DOM.filenameLabel.textContent = 'Settings & Profiles';

		Editor.setLayerVisible(DOM.editLayer, false);
		Editor.setLayerVisible(DOM.viewLayer, false);

		DOM.settingsPanel.style.display = 'block';
		SettingsView.render();

		if (window.innerWidth < 768) Sidebar.collapse();
	},

	save() {
		// Save both state arrays simultaneously
		Config.saveKeychains();
		Config.saveWorkspaces();
		Status.show('Configuration saved.');
	},
}));
