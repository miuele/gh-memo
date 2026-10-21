define('plugins/text', ['lib/dom', 'lib/fileTypes', 'plugins/textEditor', 'resources'], (Dom, FileTypes, TextEditor, R) => {
	const { h } = Dom;

	let depsLoaded = false;
	const loadDeps = async () => {
		if (depsLoaded) return;
		await Promise.all([
			Dom.loadResource(R.highlightCss),
			Dom.loadResource(R.highlightJs)
		]);
		depsLoaded = true;
	};

	return {
		canHandle: (fn) => (FileTypes.isTextFile(fn) && !FileTypes.isMarkdownFile(fn)) || FileTypes.isSymlinkFile(fn),
		create: () => ({
			name: 'TextPlugin',
			supportedModes: ['edit', 'view'],
			textarea: null,
			viewLayer: null,
			filename: null,

			mount: async function(filename, content, viewLayer, editLayer, saveCallback, { isViewMode } = {}) {
				this.filename = filename;
				this.viewLayer = viewLayer;

				this.textarea = TextEditor.create(content, saveCallback);
				editLayer.appendChild(this.textarea);

				if (isViewMode) await this.renderText(filename);
			},

			onModeSwitch: async function(isViewMode) {
				// We need filename for extension detection in syntax highlighting
				if (isViewMode) await this.renderText(this.filename);
				else this.textarea.focus();
			},

			renderText: async function(filename) {
				await loadDeps();
				const ext = filename.split('.').pop().toLowerCase();
				this.viewLayer.replaceChildren(h('pre', {}, h('code', { class: "language-" + ext }, this.textarea.value)));
				this.viewLayer.querySelectorAll('pre code').forEach(block => hljs.highlightElement(block));
			},
			freeze: function() {
				if (this.textarea) {
					this.textarea.disabled = true;
				}
			},
			unmount: function() {
				this.textarea = null;
				this.viewLayer = null;
				this.filename = null;
			}
		}),
	};
});
