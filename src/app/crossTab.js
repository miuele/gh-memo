// Reacts to messages from other tabs of the app.
define('app/crossTab', ['lib/tabChannel', 'ui/editor', 'ui/fileList', 'ui/status'], (Tabs, Editor, FileList, Status) => ({
	install() {
		Tabs.onMessage((message) => {
			if (message.type === Tabs.SIDEBAR_REFRESH) FileList.render();

			// Another tab edited the file open here: lock this editor to prevent overwrites.
			if (message.type === Tabs.LOCAL_EDIT && Editor.currentFilename() === message.filename) {
				if (Editor.freeze()) Status.show(`⚠️ Edited in another tab.`, true);
			}
		});
	},
}));
