// Composition root: the one place that knows both the views and the actions.
// It wires view callbacks to actions, maps data-action attributes in
// index.html to functions, installs global listeners and starts the app.
define('app/boot',
	['model/config', 'remote/dropboxAuth',
	 'ui/refs', 'ui/editor', 'ui/fileList', 'ui/pins', 'ui/indicator', 'ui/settings', 'ui/sidebar', 'ui/status',
	 'actions/files', 'actions/sync', 'actions/pins', 'actions/workspaces', 'actions/keychains', 'actions/settings',
	 'app/router', 'app/shortcuts', 'app/paste', 'app/crossTab'],
	(Config, DropboxAuth,
	 DOM, Editor, FileList, PinsView, Indicator, SettingsView, Sidebar, Status,
	 Files, Sync, Pins, Workspaces, Keychains, Settings,
	 Router, Shortcuts, Paste, CrossTab) => {

	// Everything a data-action="..." attribute in index.html can trigger.
	const actions = {
		'files.create': () => Files.create(),
		'files.pickUpload': () => DOM.fileInput.click(),
		'files.export': () => Files.exportFile(),
		'files.delete': () => Files.remove(),
		'sync.refresh': () => Sync.refreshTree(),
		'sync.pull': () => Sync.pull(),
		'sync.push': () => Sync.push(),
		'pins.add': () => Pins.add(),
		'settings.open': () => Settings.open(),
		'sidebar.toggle': () => Sidebar.toggle(),
		'editor.toggleView': () => Editor.toggleViewMode(),
	};

	const bindViews = () => {
		Editor.bind({ onEdit: (content) => Files.handleTyping(content) });
		FileList.bind({
			open: (filename) => Files.open(filename),
			goUp: (workspaceId) => Workspaces.switchTo(workspaceId),
		});
		PinsView.bind({
			open: (absolutePath) => Pins.open(absolutePath),
			remove: (absolutePath, event) => Pins.remove(absolutePath, event),
		});
		SettingsView.bind({
			save: () => Settings.save(),
			createKeychain: () => Keychains.create(),
			deleteKeychain: (id) => Keychains.remove(id),
			linkDropbox: (id) => DropboxAuth.link(id),
			createWorkspace: () => Workspaces.create(),
			createMountPoint: (parentWs) => Workspaces.createMountPoint(parentWs),
			switchWorkspace: (id) => Workspaces.switchTo(id),
			clearDB: (id) => Workspaces.clearDB(id),
			deleteWorkspace: (id) => Workspaces.remove(id),
			isSymlinkEditMode: () => Files.isSymlinkEditMode(),
			setSymlinkEditMode: (value) => Files.setSymlinkEditMode(value),
		});
	};

	const installGlobalListeners = () => {
		CrossTab.install();
		Router.install();
		Shortcuts.install();
		Paste.install();

		document.addEventListener('click', (e) => {
			const el = e.target.closest('[data-action]');
			if (el && actions[el.dataset.action]) actions[el.dataset.action](e);
		});

		// Safety net: several click handlers (open, create, pins, ...) call
		// DBService directly without their own try/catch, on the assumption that
		// local IndexedDB reads/writes essentially never fail. That's no longer true
		// now that DBService operations can time out (see DBService.DB_TIMEOUT_MS) —
		// e.g. after Chrome/Android freezes a backgrounded PWA and IndexedDB comes
		// back wedged. Rather than auditing every call site, catch anything that
		// slips through here so a failure always surfaces in the status bar instead
		// of silently doing nothing (which is the exact symptom this is fixing).
		window.addEventListener('unhandledrejection', (event) => {
			const message = event.reason && event.reason.message ? event.reason.message : String(event.reason);
			console.error('Unhandled rejection:', event.reason);
			Status.show(`⚠️ ${message}`, true);
			event.preventDefault();
		});

		window.addEventListener('offline', () => Status.show('📴 You are offline. Changes will save locally.', true));
		window.addEventListener('online', () => Status.show('📶 You are back online. Safe to Push/Pull.'));
	};

	const onDomReady = async () => {
		// 1. Capture the DOM nodes
		DOM.init();

		// 2. Heal the state if it's a first-time load (or orphaned)
		Workspaces.ensureDefaultState();

		// 3. Render the UI safely using the active workspace
		Indicator.update();
		FileList.render();
		PinsView.render();

		// 4. Handle OAuth redirects if necessary
		await DropboxAuth.handleRedirect();

		// 5. Wire up local DOM event listeners
		DOM.fileInput.addEventListener('change', (e) => Files.handleUpload(e));
		DOM.searchBar.addEventListener('input', () => FileList.render(DOM.searchBar.value, false));
		DOM.searchBar.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				FileList.render(DOM.searchBar.value, true);
			}
		});

		// 6. Wire up the View Layer link interceptor (Hypermedia routing)
		Router.installLinkRouting();

		// 7. Check if there is a file hash in the URL to open on boot
		Router.openFromHash();
	};

	return {
		actions,

		start() {
			Config.load();
			bindViews();
			installGlobalListeners();
			window.addEventListener('DOMContentLoaded', onDomReady);
		},
	};
});
