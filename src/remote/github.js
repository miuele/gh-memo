// GitHub Contents/Git Data API provider (strictly network operations).
// Every method takes the workspace and keychain explicitly.
define('remote/github', ['lib/net', 'lib/path', 'lib/fileTypes'], (Net, Path, FileTypes) => {
	const GitHubService = {
		/* =====================================================================
		   AUXILIARY HELPERS
		===================================================================== */

		// Internal API fetcher for clean error handling and boilerplate reduction
		async _apiFetch(url, token, options = {}) {
			const res = await Net.fetchWithTimeout(url, {
				...options,
				headers: {
					'Authorization': `token ${token}`,
					'Accept': 'application/vnd.github.v3+json',
					...options.headers
				},
				cache: 'no-store'
			});

			if (!res.ok) {
				if (res.status === 404 && options.method === 'DELETE') return; // Ignore 404s on deletion
				if (res.status === 409) throw new Error("Conflict: Remote has newer changes. Please Pull first.");

				const errData = await res.json().catch(() => ({}));
				throw new Error(errData.message || `GitHub API error: ${res.status}`);
			}

			return res;
		},

		// Builds an API URL under /repos/{owner}/{repo}/. Path segments are
		// encoded one at a time, so '#', '%' and '?' in a file name stay part of
		// the path; '/' and ':' (which separates branch and path in a tree
		// revision such as "main:docs") are kept.
		_repoUrl({ host, owner, repo }, path) {
			const encodePath = (p) => p.split('/').map(seg => encodeURIComponent(seg).replace(/%3A/gi, ':')).join('/');
			return `${host}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodePath(path)}`;
		},

		// The VFS Chroot Translator: Converts local filenames to absolute remote paths
		_getFullPath(rootDir, filename) {
			const cleanRoot = Path.cleanPath(rootDir);
			// Only strip the leading slash from filename — trailing slashes on
			// file paths would be a bug upstream, but leading ones are routine.
			const cleanFile = (filename || '').replace(/^\/+/, '');
			return cleanRoot ? `${cleanRoot}/${cleanFile}` : cleanFile;
		},

		/* =====================================================================
		   TREE OPERATIONS (From previous design)
		===================================================================== */

		async _getShallowTree(workspace, keychain) {
			const safePath = Path.cleanPath(workspace.rootDir);

			const url = `${this._repoUrl(workspace, `contents/${safePath}`)}?ref=${encodeURIComponent(workspace.branch)}`;
			const res = await this._apiFetch(url, keychain.token);
			const contents = await res.json();

			if (!Array.isArray(contents)) throw new Error(`Not a directory: ${safePath}`);

			return contents.map(item => ({
				path: item.name, 
				sha: item.sha,
				type: item.type === 'dir' ? 'folder' : 'blob',
				size: item.size || 0
			}));
		},

		async _getDeepTree(workspace, keychain) {
			const safePath = Path.cleanPath(workspace.rootDir);
			const treeRev = `${workspace.branch}:${safePath}`;

			const url = `${this._repoUrl(workspace, `git/trees/${treeRev}`)}?recursive=1`;
			const res = await this._apiFetch(url, keychain.token);
			const treeData = await res.json();

			const tree = treeData.tree
				.filter(item => item.type === 'blob') 
				.map(item => ({
					path: item.path, 
					sha: item.sha,
					type: 'blob',
					size: item.size || 0
				}));
			// GitHub cuts recursive listings off at 100,000 entries / 7 MB.
			return { tree, truncated: !!treeData.truncated };
		},

		async getTree(workspace, keychain) {
			if (!keychain || !keychain.token) throw new Error("Missing credentials in keychain.");
			if (!workspace.owner || !workspace.repo) throw new Error("Repository owner and name are not configured.");

			if (workspace.shallow) return { tree: await this._getShallowTree(workspace, keychain), truncated: false };
			return this._getDeepTree(workspace, keychain);
		},

		/* =====================================================================
		   FILE OPERATIONS (Refined for VFS)
		===================================================================== */

		async getFile(filename, workspace, keychain) {
			const fullPath = this._getFullPath(workspace.rootDir, filename);
			const url = `${this._repoUrl(workspace, `contents/${fullPath}`)}?ref=${encodeURIComponent(workspace.branch)}`;

			const isText = FileTypes.isTextFile(filename);

			// For text, we request standard JSON (Base64). For binaries, we request raw bytes.
			const headers = isText 
				? {} 
				: { 'Accept': 'application/vnd.github.raw' };

			const res = await this._apiFetch(url, keychain.token, { headers });

			// Handle Binary Files
			if (!isText) {
				const rawBlob = await res.blob();
				return new Blob([rawBlob], { type: FileTypes.mimeTypeFor(filename) });
			}

			// Handle Text Files
			return await res.json();
		},

		async putFile(filename, contentBase64, sha, commitMsg, workspace, keychain) {
			const fullPath = this._getFullPath(workspace.rootDir, filename);
			const { branch } = workspace;
			const url = this._repoUrl(workspace, `contents/${fullPath}`);

			const payload = { 
				message: commitMsg || `Update ${filename}`, 
				content: contentBase64, 
				branch: branch 
			};
			if (sha) payload.sha = sha;

			const res = await this._apiFetch(url, keychain.token, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			});

			return await res.json();
		},

		async deleteFile(filename, sha, workspace, keychain) {
			const fullPath = this._getFullPath(workspace.rootDir, filename);
			const { branch } = workspace;
			const url = this._repoUrl(workspace, `contents/${fullPath}`);

			const payload = { 
				message: `Delete note: ${filename}`, 
				sha: sha, 
				branch: branch 
			};

			// Note: _apiFetch explicitly ignores 404s on DELETE
			await this._apiFetch(url, keychain.token, {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			});
		},

		fileUploadSizeLimit() {
			return 10 * 1024 * 1024; // 10MB hard limit for GitHub Contents API
		}
	};

	return GitHubService;
});
