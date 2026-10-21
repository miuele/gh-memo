// The status bar at the bottom of the editor.
define('ui/status', ['ui/refs'], (DOM) => {
	let statusTimerId = null;

	return {
		show(text, isError = false) {
			// Cancel any in-flight auto-hide so a rapid second call cannot
			// cause the previous timer to dismiss the new message early.
			clearTimeout(statusTimerId);
			DOM.statusBar.textContent = text;
			DOM.statusBar.style.display = 'flex';
			DOM.statusBar.className = isError ? 'error' : '';
			if (!isError) {
				statusTimerId = setTimeout(() => DOM.statusBar.style.display = 'none', 4000);
			}
		},
		hide() {
			DOM.statusBar.style.display = 'none';
		},
	};
});
