// Markdown notes: a textarea to edit, and a rendered view with KaTeX math and
// highlighted code. Local images are read through the plugin host, which
// also tells the view when one of them is stored or changed.
define('plugins/markdown',
	['lib/dom', 'lib/fileTypes', 'plugins/textEditor', 'ui/status', 'resources'],
	(Dom, FileTypes, TextEditor, Status, R) => {

	let depsLoaded = false;
	const loadDeps = async () => {
		if (depsLoaded) return;
		Status.show('Loading Markdown engine...', false);
		await Promise.all([
			Dom.loadResource(R.marked),
			Dom.loadResource(R.dompurify),
			Dom.loadResource(R.katexCss),
			Dom.loadResource(R.katexJs),
			Dom.loadResource(R.highlightJs),
			Dom.loadResource(R.highlightCss),
		]);

		// Load the extension after KaTeX has been loaded
		await Dom.loadResource(R.markedKatex);

		marked.use(
			window.markedKatex({ throwOnError: false, output: 'html' }),
			{
				renderer: {
					image(token) {
						// Hold the URL in data-src, so nothing loads before renderMarkdown decides
						return `<img data-src="${token.href}" alt="${token.text || ''}" title="${token.title || ''}" />`;
					}
				}
			});
		depsLoaded = true;
		Status.show('Markdown engine loaded.');
	};

	return {
		canHandle: (fn) => FileTypes.isMarkdownFile(fn),
		create: () => ({
			name: 'MarkdownPlugin',
			supportedModes: ['edit', 'view'],
			textarea: null,
			viewLayer: null,
			filename: null,
			host: null,
			isViewMode: false,
			unsubscribe: null,
			// Only the latest of overlapping renders updates the view.
			renders: 0,

			mount: async function(filename, content, viewLayer, editLayer, saveCallback, { isViewMode, host } = {}) {
				this.filename = filename;
				this.viewLayer = viewLayer;
				this.host = host || null;
				this.isViewMode = !!isViewMode;

				// Ask the factory for a standard editor, but the plugin still OWNS it
				this.textarea = TextEditor.create(content, saveCallback);
				editLayer.appendChild(this.textarea);

				// An image pulled, pasted or edited elsewhere shows without reopening the note.
				if (this.host) this.unsubscribe = this.host.onChange(() => this.isViewMode && this.renderMarkdown());

				if (isViewMode) await this.renderMarkdown();
			},

			onModeSwitch: async function(isViewMode) {
				this.isViewMode = isViewMode;
				if (isViewMode) await this.renderMarkdown();
				else this.textarea.focus();
			},

			// The stored image for a local src, through the host. Null when it isn't
			// stored, or the path is refused (e.g. above the repo root).
			readImage: async function(src) {
				if (!this.host) return null;
				try {
					const file = await this.host.read(src);
					return file && file.content instanceof Blob ? file.content : null;
				} catch (err) {
					console.warn(`Image ${src}:`, err.message);
					return null;
				}
			},

			renderMarkdown: async function() {
				const render = ++this.renders;
				await loadDeps();
				if (!this.textarea || render !== this.renders) return;

				let processedText = this.textarea.value
				        // Ensure block math has a preceding empty line (prevents it being swallowed by paragraphs)
				        .replace(/([^\n])\n(\s*\$\$)/g, '$1\n\n$2')
				        // Ensure block math has a following empty line
				        .replace(/(\$\$\s*)\n([^\n])/g, '$1\n\n$2')
				        // Add a space between math and trailing punctuation/hyphens ($x$) -> $x$ )
				        // This prevents the regex boundary check from failing in marked-katex-extension
				        .replace(/(\$[^$\n]+\$)([\-\)\],\.\;\:])/g, '$1 $2');

				// 1. Register a secure hook BEFORE sanitization
				// This safely enforces new tabs for all links during the sanitization pass
				DOMPurify.addHook('afterSanitizeAttributes', function(node) {
				    if (node.tagName === 'A') {
				        node.setAttribute('target', '_blank');
				        node.setAttribute('rel', 'noopener noreferrer');
				    }
				    // An HTML <img> with a local src is looked up like a Markdown image.
				    if (node.tagName === 'IMG' && node.hasAttribute('src') && !/^(https?:|data:)/i.test(node.getAttribute('src'))) {
				        node.setAttribute('data-src', node.getAttribute('src'));
				        node.removeAttribute('src');
				    }
				});

				const rawHtml = marked.parse(processedText);

				// 2. Execute sanitization using explicit Allowlist Profiles
				const safeFragment = DOMPurify.sanitize(rawHtml, {
				    // Explicitly enable only the specific safe-lists we need.
				    // By default, this obliterates all scripts, iframes, objects, and dangerous event handlers.
				    USE_PROFILES: {
				        html: true,   // Standard safe HTML (p, h1, a, strong, img, etc.)
				        mathMl: true, // Required for KaTeX equations
				        svg: true     // Required for KaTeX root/fraction symbols
				    },

				    // Explicitly enforce allowed URI schemes.
				    // This strictly blocks `<a href="javascript:alert(1)">` vectors.
				    ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|cid|xmpp):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
					RETURN_DOM_FRAGMENT: true,
					ADD_ATTR: ['data-src'],
				});

				safeFragment.querySelectorAll('pre code').forEach(block => hljs.highlightElement(block));

				// Remove the hook after use so it doesn't bleed into other plugins
				DOMPurify.removeHook('afterSanitizeAttributes');

				const imgPromises = Array.from(safeFragment.querySelectorAll('img')).map(async (img) => {
					// Read from our safe data attribute
					const src = img.getAttribute('data-src');
					if (!src) return;

					if (!src.match(/^(http|https|data:)/i)) {
						// Local image, from the stored copy
						const blob = await this.readImage(src);
						if (blob) {
							const objectUrl = URL.createObjectURL(blob);
							img.src = objectUrl; // Assigning the real src safely
							img.onload = () => URL.revokeObjectURL(objectUrl);
						} else {
							img.alt = `[Image missing locally: ${src}]`;
						}
					} else {
						// Remote image: the browser loads it (see backlog, Deferred)
						img.src = src;
					}
				});

				await Promise.all(imgPromises);

				if (this.viewLayer && render === this.renders) this.viewLayer.replaceChildren(safeFragment);
			},

			freeze: function() {
				if (this.textarea) {
					this.textarea.disabled = true;
				}
			},

			unmount: function() {
				if (this.unsubscribe) this.unsubscribe();
				this.unsubscribe = null;
				this.host = null;
				this.textarea = null;
				this.viewLayer = null;
				this.filename = null;
			}
		}),
	};
});
