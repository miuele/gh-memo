define('ui/sidebar', ['ui/refs'], (DOM) => ({
	toggle() {
		DOM.sidebar.classList.toggle('collapsed');
	},
	collapse() {
		DOM.sidebar.classList.add('collapsed');
	},
	isCollapsed() {
		return DOM.sidebar.classList.contains('collapsed');
	},
}));
