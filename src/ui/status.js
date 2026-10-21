// The status bar at the bottom of the editor.
define('ui/status', ['ui/refs', 'lib/dom'], (DOM, Dom) => {
	let statusTimerId = null;
	// A standing notice with a button ({ text, label, onClick }), e.g. a new
	// version waiting. Messages cover it for a while; hiding brings it back.
	let offer = null;

	const showOffer = () => {
		DOM.statusBar.replaceChildren(offer.text, Dom.h('button', { class: 'status-action', onclick: offer.onClick }, offer.label));
		DOM.statusBar.style.display = 'flex';
		DOM.statusBar.className = 'offer';
	};

	const Status = {
		show(text, isError = false) {
			// Cancel any in-flight auto-hide so a rapid second call cannot
			// cause the previous timer to dismiss the new message early.
			clearTimeout(statusTimerId);
			DOM.statusBar.textContent = text;
			DOM.statusBar.style.display = 'flex';
			DOM.statusBar.className = isError ? 'error' : '';
			if (!isError) {
				statusTimerId = setTimeout(() => Status.hide(), 4000);
			}
		},
		hide() {
			if (offer) return showOffer();
			DOM.statusBar.style.display = 'none';
		},

		// Shows a notice that stays until the page reloads.
		offer(text, label, onClick) {
			clearTimeout(statusTimerId);
			offer = { text, label, onClick };
			showOffer();
		},
	};

	return Status;
});
