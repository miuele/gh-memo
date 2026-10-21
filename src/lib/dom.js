define('lib/dom', [], () => {
	// Tiny element builder: h('li', { class: 'x', onclick: fn }, 'text', childEl)
	const h = (tag, props, ...children) => {
		const el = document.createElement(tag);
		for (const key in props) {
			if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), props[key]);
			else el.setAttribute(key, props[key]);
		}
		children.forEach(c => typeof c === 'string' ? el.appendChild(document.createTextNode(c)) : el.appendChild(c));
		return el;
	};

	// Injects a <script> or stylesheet <link> once, with SRI enforced.
	// `resource` is an entry from the `resources` module: { url, sri }.
	const loadResource = async ({ url, sri }) => {
		return new Promise((resolve, reject) => {
			// Prevent duplicate loading
			if (document.querySelector(`[src="${url}"], [href="${url}"]`)) return resolve();

			const isCss = url.split('?')[0].endsWith('.css');
			const el = document.createElement(isCss ? 'link' : 'script');

			if (isCss) {
				el.rel = 'stylesheet';
				el.href = url;
			} else {
				el.src = url;
			}

			// Apply SRI strict enforcement
			if (sri) {
				el.integrity = sri;
				el.crossOrigin = 'anonymous'; // Required for SRI validation
			}

			el.onload = resolve;
			el.onerror = () => reject(new Error(`Failed to load resource: ${url}`));
			document.head.appendChild(el);
		});
	};

	return { h, loadResource };
});
