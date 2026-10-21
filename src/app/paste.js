// Pasting an image while the sidebar has focus saves it as a new local file.
define('app/paste', ['actions/files'], (Files) => ({
	install() {
		document.addEventListener('paste', async (e) => {
			// Allow paste when focus is on the sidebar
			if (e.target.tagName === 'INPUT' || !e.target.closest('#sidebar')) {
				return;
			}

			const clipboardData = e.clipboardData || window.clipboardData;
			const items = clipboardData.items;

			for (let i = 0; i < items.length; i++) {
				const item = items[i];

				if (item.type.indexOf('image') !== -1) {
					e.preventDefault();

					const blob = item.getAsFile();
					if (!blob) continue;

					await Files.savePastedImage(blob);
					break;
				}
			}
		});
	},
}));
