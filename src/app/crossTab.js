// Reacts to messages from other tabs of the app, and tells them about this
// tab's writes to the local cache.
define('app/crossTab',
	['model/config', 'lib/tabChannel', 'storage/notesDb', 'ui/editor', 'ui/fileList', 'ui/status', 'actions/host'],
	(Config, Tabs, DBService, Editor, FileList, Status, Host) => ({
	install() {
		// Plugin views in other tabs may show this file (see actions/host).
		DBService.onWrite(({ dbName, filename }) => Tabs.post({ type: Tabs.NOTE_WRITTEN, dbName, filename }));

		Tabs.onMessage((message) => {
			if (message.type === Tabs.SIDEBAR_REFRESH) FileList.render();
			if (message.type === Tabs.NOTE_WRITTEN) Host.changed(message.dbName, message.filename);

			// Another tab edited the file open here: lock this editor to prevent overwrites.
			// The same filename in another workspace is a different file.
			const ws = Config.activeWorkspace;
			if (message.type === Tabs.LOCAL_EDIT && ws && ws.dbName === message.dbName && Editor.currentFilename() === message.filename) {
				if (Editor.freeze()) Status.show(`⚠️ Edited in another tab.`, true);
			}
		});
	},
}));
