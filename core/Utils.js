const Utils = {
	utoa: (text) => btoa(Array.from(new TextEncoder().encode(text)).map(b => String.fromCharCode(b)).join('')),
	atou: (b64) => new TextDecoder().decode(new Uint8Array(atob(b64.replace(/[\r\n]+/g, '')).split('').map(c => c.charCodeAt(0)))),

	// Default ceiling for any single remote request (GitHub/Dropbox APIs).
	// Chosen to comfortably cover slow mobile connections without leaving
	// the UI hung indefinitely on a stalled socket.
	NETWORK_TIMEOUT_MS: 10000,

	// A fetch() wrapper that aborts the request after `timeoutMs` and throws
	// a clearly-labeled Error instead of the raw (unhelpful) AbortError.
	// Every remote call in the app routes through this so a stalled network
	// always surfaces a bounded, user-visible failure rather than a silent hang.
	// Callers can pass their own AbortSignal via options.signal; in that case
	// we still race it against our own timeout by aborting our controller
	// whenever the caller's signal aborts.
	//
	// IMPORTANT: fetch() resolves as soon as response *headers* arrive, not
	// once the body has finished downloading. Every call site in this app
	// reads the body (res.json()/res.blob()/res.text()) separately, after
	// fetchWithTimeout has already returned. If we disarmed the timer at
	// that point, a slow body transfer (which is where nearly all of the
	// time goes on a throttled connection, since GitHub/Dropbox payloads
	// are the response body) would run completely unguarded. So instead of
	// clearing the timer here, we hand back the Response with its
	// body-reading methods wrapped: the same timeout budget, and the same
	// AbortController, stay live until the body is actually consumed (or
	// fails), and the timer is only cleared then.
	fetchWithTimeout: async (url, options = {}, timeoutMs = Utils.NETWORK_TIMEOUT_MS) => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);

		const { signal: callerSignal, ...restOptions } = options;
		if (callerSignal) {
			if (callerSignal.aborted) controller.abort();
			else callerSignal.addEventListener('abort', () => controller.abort(), { once: true });
		}

		const timeoutError = () => new Error(`Request timed out. Check your connection and try again.`);

		let res;
		try {
			res = await fetch(url, { ...restOptions, signal: controller.signal });
		} catch (err) {
			clearTimeout(timer);
			throw err.name === 'AbortError' ? timeoutError() : err;
		}

		// Wrap the body-consuming methods so the timeout guard spans the
		// full transfer, not just the initial round trip. Non-body members
		// (res.ok, res.status, res.headers, ...) pass through untouched.
		const bodyMethods = ['json', 'text', 'blob', 'arrayBuffer', 'formData'];
		return new Proxy(res, {
			get(target, prop, receiver) {
				if (bodyMethods.includes(prop)) {
					return async (...args) => {
						try {
							return await target[prop](...args);
						} catch (err) {
							throw err.name === 'AbortError' ? timeoutError() : err;
						} finally {
							clearTimeout(timer);
						}
					};
				}
				const value = Reflect.get(target, prop, target);
				return typeof value === 'function' ? value.bind(target) : value;
			}
		});
	},

	// Strips leading and trailing slashes from a path segment.
	// Centralises the normalization pattern used throughout VFS and the provider services.
	cleanPath: (str) => (str || '').replace(/(^\/+|\/+$)/g, ''),

	// Converts a Blob to a base64 string using chunked reads to stay within
	// call-stack limits for large files (avoids a single massive fromCharCode call).
	blobToBase64: async (blob) => {
		const buffer = await new Response(blob).arrayBuffer();
		const bytes = new Uint8Array(buffer);
		let binary = '';
		const chunkSize = 8192;
		for (let i = 0; i < bytes.length; i += chunkSize) {
			binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
		}
		return btoa(binary);
	},

	isImageFile: (filename) => /\.(png|jpg|jpeg|gif|svg|webp|ico)$/i.test(filename || ''),
	isPdfFile: (filename) => /\.pdf$/i.test(filename || ''),
	isTextFile: (filename) => {
		// Files with no extension are usually text (e.g., Makefile, .env)
		if (!filename.includes('.')) return true; 
		// Add or remove extensions to this regex as needed
		return /\.(txt|md|markdown|rst|csv|json|xml|html|css|js|ts|jsx|tsx|py|yml|yaml|ini|env|sh|bat|m4|ps1|c|cpp|h|rs|go|java|toml|sml|gitignore|symlink)$/i.test(filename);
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
	loadResource: async (url, integrity = null) => {
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
			if (integrity) {
				el.integrity = integrity;
				el.crossOrigin = 'anonymous'; // Required for SRI validation
			}

			el.onload = resolve;
			el.onerror = () => reject(new Error(`Failed to load resource: ${url}`));
			document.head.appendChild(el);
		});
	},
	createStandardEditor: (content, saveCallback) => {
		const textarea = document.createElement('textarea');
		textarea.style.cssText = 'display: block; width: 100%; height: 100%; box-sizing: border-box; padding: 20px; border: none; resize: none; outline: none; font-family: monospace; font-size: 15px; line-height: 1.5;';
		textarea.value = typeof content === 'string' ? content : '';

		// Auto-save hook
		textarea.addEventListener('input', (e) => saveCallback(e.target.value));

		// Standard Tab key indentation
		textarea.addEventListener('keydown', function(e) {
			if (e.key === 'Tab') {
				e.preventDefault();
				document.execCommand('insertText', false, '    ');
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
