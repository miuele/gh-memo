Image: {
	canHandle: (fn) => /\.(png|jpg|jpeg|gif|svg|webp|ico)$/i.test(fn || ''),
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
},

PDF: {
	canHandle: (fn) => /\.pdf$/i.test(fn || ''),
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
},

Markdown: {
	canHandle: (fn) => /\.(md|markdown)$/i.test(fn || ''),
		depsLoaded: false,

		loadDeps: async function() {
			if (this.depsLoaded) return;
			UI.showStatus('Loading Markdown engine...', false);
			await Promise.all([
				Utils.loadResource('https://cdn.jsdelivr.net/npm/marked/marked.min.js'),
				Utils.loadResource('https://cdn.jsdelivr.net/npm/dompurify/dist/purify.min.js'),
				Utils.loadResource('https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css', 'style'),
				Utils.loadResource('https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js'),
				Utils.loadResource('https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css', 'style'),
				Utils.loadResource('https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js')
			]);
			await Utils.loadResource('https://cdn.jsdelivr.net/npm/marked-katex-extension@5.0.0/lib/index.umd.js');
			marked.use(
				window.markedKatex({ throwOnError: false, output: 'html' }),
				{
					renderer: {
						image(token) {
							// Prevent eager fetching by holding the URL in data-src
							return `<img data-src="${token.href}" alt="${token.text || ''}" title="${token.title || ''}" />`;
						}
					}
				});
			this.depsLoaded = true;
			UI.showStatus('Markdown engine loaded.');
		},

		create: () => ({
			name: 'MarkdownPlugin',
			supportedModes: ['edit', 'view'],
			textarea: null,
			viewLayer: null,
			filename: null,


			mount: async function(filename, content, viewLayer, editLayer, saveCallback) {
				this.filename = filename;
				this.viewLayer = viewLayer;

				// Ask the factory for a standard editor, but the plugin still OWNS it
				this.textarea = Utils.createStandardEditor(content, saveCallback);
				editLayer.appendChild(this.textarea);

				if (AppState.isViewMode) await this.renderMarkdown();
			},

			onModeSwitch: async function(isViewMode) {
				if (isViewMode) await this.renderMarkdown();
				else this.textarea.focus();
			},

			renderMarkdown: async function() {
				await Plugins.Markdown.loadDeps();

				const rawHtml = marked.parse(this.textarea.value);

				// Must explicitly tell DOMPurify that data-src is a safe attribute
				const safeFragment = DOMPurify.sanitize(rawHtml, { 
					RETURN_DOM_FRAGMENT: true,
					ADD_ATTR: ['data-src'] 
				});

				safeFragment.querySelectorAll('pre code').forEach(block => hljs.highlightElement(block));

				const imgPromises = Array.from(safeFragment.querySelectorAll('img')).map(async (img) => {
					// Read from our safe data attribute
					const src = img.getAttribute('data-src'); 
					if (!src) return;

					if (!src.match(/^(http|https|data:)/i)) {
						// Local Image Lookup
						const file = await DBService.get(Utils.resolvePath(this.filename, src));
						if (file && file.content instanceof Blob) {
							const objectUrl = URL.createObjectURL(file.content);
							img.src = objectUrl; // Assigning the real src safely
							img.onload = () => URL.revokeObjectURL(objectUrl); 
						} else {
							img.alt = `[Image missing locally: ${src}]`;
						}
					} else {
						// External Web Image: Safe to fetch now
						img.src = src; 
					}
				});

				await Promise.all(imgPromises);

				this.viewLayer.replaceChildren(safeFragment);
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
},

Text: {
	canHandle: (fn) => (Utils.isTextFile(fn) && !/\.(md|markdown)$/i.test(fn || '')) || /\.symlink$/i.test(fn || ''),
		depsLoaded: false,

		loadDeps: async function() {
			if (this.depsLoaded) return;
			await Promise.all([
				Utils.loadResource('https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css', 'style'),
				Utils.loadResource('https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js')
			]);
			this.depsLoaded = true;
		},

		create: () => ({
			name: 'TextPlugin',
			supportedModes: ['edit', 'view'],
			textarea: null,
			viewLayer: null,
			filename: null,

			mount: async function(filename, content, viewLayer, editLayer, saveCallback) {
				this.filename = filename;
				this.viewLayer = viewLayer;

				// Use the exact same factory here
				this.textarea = Utils.createStandardEditor(content, saveCallback);
				editLayer.appendChild(this.textarea);

				if (AppState.isViewMode) await this.renderText(filename);
			},

			onModeSwitch: async function(isViewMode) {
				// We need filename for extension detection in syntax highlighting
				if (isViewMode) await this.renderText(this.filename); 
				else this.textarea.focus();
			},

			renderText: async function(filename) {
				await Plugins.Text.loadDeps();
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
			}
		}),
},

Unsupported: {
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
},
