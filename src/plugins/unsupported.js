define('plugins/unsupported', ['lib/dom'], (Dom) => {
	const { h } = Dom;

	return {
		canHandle: () => true, // Catch-all fallback
		create: () => ({
			name: 'UnsupportedPlugin',
			supportedModes: ['view'],
			viewLayer: null,
			mount: async function(filename, content, viewLayer, editLayer, saveCallback) {
				this.viewLayer = viewLayer;
				this.viewLayer.appendChild(
					h('div', { style: "text-align: center; color: #888; margin-top: 40px; padding: 20px; border: 2px dashed #ccc; border-radius: 8px;" },
						h('div', { style: "font-size: 40px; margin-bottom: 15px;" }, "📦"),
						h('i', {}, "Binary File"),
						h('span', { style: "font-size: 13px;" }, "This file cannot be previewed, but it can be synced to your cloud provider."),
					)
				);

			},
			unmount: function() {
				this.viewLayer.replaceChildren();
			}
		}),
	};
});
