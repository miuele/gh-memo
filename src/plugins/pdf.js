define('plugins/pdf', ['lib/dom', 'lib/fileTypes'], (Dom, FileTypes) => {
	const { h } = Dom;

	return {
		canHandle: (fn) => FileTypes.isPdfFile(fn),
		create: () => ({
			name: 'PDFPlugin',
			supportedModes: ['view'],
			objectUrl: null,
			viewLayer: null,
			mount: async function(filename, content, viewLayer, editLayer, saveCallback) {
				this.viewLayer = viewLayer;

				if (content instanceof Blob) {
					this.objectUrl = URL.createObjectURL(content);
					this.viewLayer.appendChild(
						h('iframe', { src: this.objectUrl + "#toolbar=0", style: "width: 100%; height: 85vh; border: 1px solid var(--border); border-radius: 4px;"}));
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
