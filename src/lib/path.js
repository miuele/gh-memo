define('lib/path', [], () => {
	// Strips leading and trailing slashes from a path segment.
	// Centralises the normalization pattern used throughout VFS and the provider services.
	const cleanPath = (str) => (str || '').replace(/(^\/+|\/+$)/g, '');

	// Resolves a link target relative to the file that contains it.
	const resolvePath = (basePath, relativePath) => {
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
	};

	// Like resolvePath, but for paths that must stay inside one tree: a
	// leading '/' starts at the root, and a '..' above the root gives null
	// instead of being dropped.
	const resolveWithin = (basePath, relativePath) => {
		const stack = relativePath.startsWith('/') ? [] : basePath.split('/').slice(0, -1);
		for (const part of relativePath.split('/')) {
			if (part === '' || part === '.') continue;
			if (part !== '..') stack.push(part);
			else if (!stack.length) return null;
			else stack.pop();
		}
		return stack.join('/');
	};

	const parsePath = (path) => {
		const lastSlash = path.lastIndexOf('/');
		const dir = lastSlash === -1 ? '' : path.substring(0, lastSlash + 1);
		const filename = lastSlash === -1 ? path : path.substring(lastSlash + 1);
		const lastDot = filename.lastIndexOf('.');
		const basename = lastDot === -1 ? filename : filename.substring(0, lastDot);
		return { dir, filename, basename };
	};

	return { cleanPath, resolvePath, resolveWithin, parsePath };
});
