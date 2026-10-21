// The pin tags under the sidebar buttons.
define('ui/pins', ['ui/refs', 'lib/dom', 'model/forest'], (DOM, Dom, Forest) => {
	const { h } = Dom;
	let handlers = { open() {}, remove() {} };

	return {
		// handlers: { open(absolutePath), remove(absolutePath, event) }
		bind(hs) { handlers = hs; },

		render() {
			DOM.pinContainer.replaceChildren();
			const pins = Forest.activePins(); // Read from the Forest level

			pins.forEach(pin => {
				DOM.pinContainer.appendChild(
					h('span', { class: 'pin-tag', onclick: () => handlers.open(pin) },
						h('span', {}, pin),
						h('span', { class: 'pin-rm', onclick: e => handlers.remove(pin, e) }, '×'),
					)
				);
			});
		},
	};
});
