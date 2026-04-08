const Utils = {
	utoa: (text) => btoa(Array.from(new TextEncoder().encode(text)).map(b => String.fromCharCode(b)).join('')),
	atou: (b64) => new TextDecoder().decode(new Uint8Array(atob(b64.replace(/[\r\n]+/g, '')).split('').map(c => c.charCodeAt(0)))),
	isImageFile: (filename) => /\.(png|jpg|jpeg|gif|svg|webp|ico)$/i.test(filename || ''),
	isPdfFile: (filename) => /\.pdf$/i.test(filename || ''),
	isTextFile: (filename) => {
		// Files with no extension are usually text (e.g., Makefile, .env)
		if (!filename.includes('.')) return true; 
		// Add or remove extensions to this regex as needed
		return /\.(txt|md|markdown|rst|csv|json|xml|html|css|js|ts|jsx|tsx|py|yml|yaml|ini|env|sh|bat|ps1|c|cpp|h|rs|go|java|toml|sml)$/i.test(filename);
	},
	resolvePath: (basePath, relativePath) => {
		// Ignore external web links and base64 data URIs
		if (relativePath.match(/^(http|https|data:|mailto:|#)/i)) return relativePath;

		const stack = basePath.split('/').slice(0, -1); // Get current directory
		const parts = relativePath.split('/');

		for (const part of parts) {
			if (part === '.') continue;
			if (part === '..') stack.pop();
			else stack.push(part);
		}
		return stack.join('/');
	},
	parsePath: (path) => {
		const lastSlash = path.lastIndexOf('/');
		const dir = lastSlash === -1 ? '' : path.substring(0, lastSlash + 1);
		const filename = lastSlash === -1 ? path : path.substring(lastSlash + 1);
		const lastDot = filename.lastIndexOf('.');
		const basename = lastDot === -1 ? filename : filename.substring(0, lastDot);
		return { dir, filename, basename };
	},
	loadResource: (url, type = 'script') => {
		return new Promise((resolve, reject) => {
			// Don't load the same file twice
			if (document.querySelector(`[src="${url}"]`) || document.querySelector(`[href="${url}"]`)) return resolve();

			let el;
			if (type === 'script') {
				el = document.createElement('script');
				el.src = url;
			} else if (type === 'style') {
				el = document.createElement('link');
				el.rel = 'stylesheet';
				el.href = url;
			}
			el.onload = resolve;
			el.onerror = reject;
			document.head.appendChild(el);
		});
	},
	createStandardEditor: (content, saveCallback) => {
		const textarea = document.createElement('textarea');
		textarea.style.cssText = 'width: 100%; height: 100%; box-sizing: border-box; padding: 20px; border: none; resize: none; outline: none; font-family: monospace; font-size: 15px; line-height: 1.5;';
		textarea.value = typeof content === 'string' ? content : '';

		// Auto-save hook
		textarea.addEventListener('input', (e) => saveCallback(e.target.value));

		// Standard Tab key indentation
		textarea.addEventListener('keydown', function(e) {
			if (e.key === 'Tab') {
				e.preventDefault();
				const start = this.selectionStart, end = this.selectionEnd;
				this.value = this.value.substring(0, start) + "    " + this.value.substring(end);
				this.selectionStart = this.selectionEnd = start + 4;
				saveCallback(this.value);
			}
		});

		return textarea;
	},
	// PKCE Helper: Generates a cryptographically random string
	generateCodeVerifier: () => {
		const array = new Uint32Array(28);
		window.crypto.getRandomValues(array);
		return Array.from(array, dec => ('0' + dec.toString(16)).slice(-2)).join('');
	},

	// PKCE Helper: Hashes the verifier into a base64-url encoded challenge
	generateCodeChallenge: async (verifier) => {
		const encoder = new TextEncoder();
		const data = encoder.encode(verifier);
		const digest = await window.crypto.subtle.digest('SHA-256', data);
		return btoa(String.fromCharCode(...new Uint8Array(digest)))
			.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	},
	h: (tag, props, ...children) => {
		const el = document.createElement(tag);
		for (const key in props) {
			if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), props[key]);
			else el.setAttribute(key, props[key]);
		}
		children.forEach(c => typeof c === 'string' ? el.appendChild(document.createTextNode(c)) : el.appendChild(c));
		return el;
	},
};

const h = Utils.h;

