define('actions/settings',
	['model/config', 'model/forest', 'ui/refs', 'ui/editor', 'ui/settings', 'ui/sidebar'],
	(Config, Forest, DOM, Editor, SettingsView, Sidebar) => ({

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
		const forced = this.forceShallowParents();
		Config.saveKeychains();
		Config.saveWorkspaces();
		if (forced) SettingsView.render();
	},

	// A workspace with a mount below it must be shallow (Forest.hasMountsBelow).
	// The stored flag is set here, so it always says what Refresh will do; it
	// stays set when the mounts below go away. Returns whether anything changed.
	forceShallowParents() {
		let changed = false;
		for (const id of Object.keys(Config.workspaces)) {
			if (!Config.workspaces[id].shallow && Forest.hasMountsBelow(id)) {
				Config.workspaces[id].shallow = true;
				changed = true;
			}
		}
		return changed;
	},
}));
