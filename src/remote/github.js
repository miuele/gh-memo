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
			const { host, owner, repo, branch, rootDir } = workspace;
			const safePath = Path.cleanPath(rootDir);

			const url = `${host}/repos/${owner}/${repo}/contents/${safePath}?ref=${branch}`;
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
			const { host, owner, repo, branch, rootDir } = workspace;
			const safePath = Path.cleanPath(rootDir);
			const treeRev = `${branch}:${safePath}`;

			const url = `${host}/repos/${owner}/${repo}/git/trees/${treeRev}?recursive=1`;
			const res = await this._apiFetch(url, keychain.token);
			const treeData = await res.json();

			if (treeData.truncated) console.warn("GitHub API Warning: Tree truncated.");

			return treeData.tree
				.filter(item => item.type === 'blob') 
				.map(item => ({
					path: item.path, 
					sha: item.sha,
					type: 'blob',
					size: item.size || 0
				}));
		},

		async getTree(workspace, keychain) {
			if (!keychain || !keychain.token) throw new Error("Missing credentials in keychain.");
			if (!workspace.owner || !workspace.repo) throw new Error("Repository owner and name are not configured.");

			const tree = workspace.shallow 
				? await this._getShallowTree(workspace, keychain)
				: await this._getDeepTree(workspace, keychain);

			return { tree };
		},

		/* =====================================================================
		   FILE OPERATIONS (Refined for VFS)
		===================================================================== */

		async getFile(filename, workspace, keychain) {
			const fullPath = this._getFullPath(workspace.rootDir, filename);
			const { host, owner, repo, branch } = workspace;
			const url = `${host}/repos/${owner}/${repo}/contents/${fullPath}?ref=${branch}`;

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
			const { host, owner, repo, branch } = workspace;
			const url = `${host}/repos/${owner}/${repo}/contents/${fullPath}`;

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
			const { host, owner, repo, branch } = workspace;
			const url = `${host}/repos/${owner}/${repo}/contents/${fullPath}`;

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
