define('actions/settings',
	['model/config', 'ui/refs', 'ui/editor', 'ui/settings', 'ui/sidebar'],
	(Config, DOM, Editor, SettingsView, Sidebar) => ({

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

	// Called by the settings view on every committed change; it shows its
	// own quiet "Saved ✓", so no status message here.
	save() {
		Config.saveKeychains();
		Config.saveWorkspaces();
	},
}));
