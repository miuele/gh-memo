// The editor area: mounts the plugin for the open file into the view/edit
// layers, switches between view and edit mode, and shows the file chrome
// (export/pull/push/delete buttons).
define('ui/editor', ['ui/refs', 'ui/sidebar', 'ui/status', 'plugins/registry'], (DOM, Sidebar, Status, Plugins) => {
	let currentFilename = null;
	let isViewMode = false;
	let activePlugin = null;
	let isFrozen = false;
	let handlers = { onEdit() {} };

	const setLayerVisible = (layer, isVisible) => {
		layer.style.display = 'block';
		layer.style.visibility = isVisible ? 'visible' : 'hidden';
		layer.style.opacity = isVisible ? '1' : '0';
		layer.style.pointerEvents = isVisible ? 'auto' : 'none';
	};

	// Toggles the editor chrome buttons (save/pull/push/delete) as a unit.
	// Both reset and activate maintain this set — a helper
	// ensures they stay in sync with no risk of one growing out of step.
	const setEditorChrome = (isOpen) => {
		const display = isOpen ? 'block' : 'none';
		DOM.saveBtn.style.display = display;
		DOM.pullBtn.style.display = display;
		DOM.pushBtn.style.display = display;
		DOM.deleteBtn.style.display = display;
	};

	const unmountPlugin = () => {
		if (activePlugin && activePlugin.unmount) {
			activePlugin.unmount();
			activePlugin = null;
		}
	};

	const Editor = {
		// handlers: { onEdit(newContent) }
		bind(h) { handlers = h; },

		currentFilename: () => currentFilename,
		activePlugin: () => activePlugin,
		setLayerVisible,

		// Closes the open file and hides every layer.
		reset() {
			isViewMode = false;
			currentFilename = null;
			document.title = 'gh-memo';

			// 1. Unmount any active plugin to free memory
			unmountPlugin();

			// 2. Clear and reset the agnostic layers
			DOM.editLayer.replaceChildren();
			DOM.viewLayer.replaceChildren();
			setLayerVisible(DOM.editLayer, false);
			setLayerVisible(DOM.viewLayer, false);

			DOM.filenameLabel.textContent = 'No file selected';
			setEditorChrome(false);
			Status.hide();
			DOM.viewToggle.style.display = 'none';
			if (DOM.settingsPanel) DOM.settingsPanel.style.display = 'none';
		},

		// Opens `filename` with `content` in the matching plugin.
		async activate(filename, content) {
			currentFilename = filename;
			DOM.filenameLabel.textContent = filename;
			document.title = filename;
			Status.hide();

			// Reset any previous cross-tab freezes
			isFrozen = false;
			DOM.pullBtn.disabled = false;
			DOM.pushBtn.disabled = false;
			DOM.editLayer.style.opacity = '1';
			DOM.editLayer.style.pointerEvents = 'auto';

			if (DOM.settingsPanel) DOM.settingsPanel.style.display = 'none';

			// 1. UNMOUNT
			unmountPlugin();

			// 2. NEGOTIATE & INSTANTIATE
			const plugin = Plugins.find(filename).create();
			// Note: activePlugin is set AFTER a successful mount. If mount() throws, the
			// previous plugin has already been unmounted but we avoid leaving activePlugin
			// pointing to a half-initialised instance.

			if (!plugin.supportedModes.includes('edit') && !isViewMode) isViewMode = true;
			else if (!plugin.supportedModes.includes('view') && isViewMode) isViewMode = false;

			// 3. PREPARE CHROME
			setEditorChrome(true);
			DOM.viewLayer.replaceChildren();
			DOM.editLayer.replaceChildren();

			// 4. PROVIDE SAVE HOOK
			const saveCallback = (newContent) => handlers.onEdit(newContent);

			// 5. MOUNT
			await plugin.mount(filename, content, DOM.viewLayer, DOM.editLayer, saveCallback, { isViewMode });
			activePlugin = plugin;

			Editor.applyModeVisibility();

			// On mobile the sidebar is a full-screen overlay. Close it automatically
			// when a file is opened so the editor is immediately visible without a
			// manual tap on the toggle strip.
			if (window.innerWidth <= 768 && !Sidebar.isCollapsed()) {
				Sidebar.toggle();
			}
		},

		applyModeVisibility() {
			const plugin = activePlugin;

			if (plugin.supportedModes.includes('view') && plugin.supportedModes.includes('edit')) {
				DOM.viewToggle.style.display = 'flex';
				DOM.viewToggle.textContent = isViewMode ? '✏️' : '👁️';
			} else {
				DOM.viewToggle.style.display = 'none';
			}

			if (isViewMode) {
				setLayerVisible(DOM.editLayer, false);
				setLayerVisible(DOM.viewLayer, true);
			} else {
				setLayerVisible(DOM.editLayer, true);
				setLayerVisible(DOM.viewLayer, false);
			}
		},

		async toggleViewMode() {
			const plugin = activePlugin;
			if (!plugin || !plugin.supportedModes.includes('view') || !plugin.supportedModes.includes('edit')) return;

			isViewMode = !isViewMode;
			Editor.applyModeVisibility();

			if (plugin.onModeSwitch) await plugin.onModeSwitch(isViewMode);
		},

		// Locks the editor because the open file was edited in another tab.
		// Returns false if it was already frozen.
		freeze() {
			if (isFrozen) return false;
			isFrozen = true;

			// 1. Core locks global Chrome
			DOM.pullBtn.disabled = true;
			DOM.pushBtn.disabled = true;
			DOM.editLayer.style.opacity = '0.6';

			// 2. Plugin locks its specific inputs
			if (activePlugin && activePlugin.freeze) {
				activePlugin.freeze();
			} else {
				// Brutal fallback if a plugin forgets to implement freeze()
				DOM.editLayer.style.pointerEvents = 'none';
			}
			return true;
		},
	};

	return Editor;
});
