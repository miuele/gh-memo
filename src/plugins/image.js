define('plugins/image', ['lib/dom', 'lib/fileTypes'], (Dom, FileTypes) => {
	const { h } = Dom;

	return {
		canHandle: (fn) => FileTypes.isImageFile(fn),
		create: () => ({
			name: 'ImagePlugin',
			supportedModes: ['view'],
			objectUrl: null, // Local memory state
			viewLayer: null,
			mount: async function(filename, content, viewLayer, editLayer, saveCallback) {
				this.viewLayer = viewLayer;

				if (content instanceof Blob) {
					this.objectUrl = URL.createObjectURL(content);
					this.viewLayer.appendChild(
						h('div', { style: "width: 100%; display: flex; justify-content: center; padding: 20px 0;" },
							h('img', { src: this.objectUrl, style: "max-width: 100%; max-height: 80vh; object-fit: contain; border-radius: 4px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);" }))
					);
				}
			},
			unmount: function() {
				if (this.objectUrl) {
					URL.revokeObjectURL(this.objectUrl);
					this.objectUrl = null;
				}
				this.viewLayer.replaceChildren();
			}
		}),
	};
});
