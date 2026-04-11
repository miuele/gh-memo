const DBService = {
	storeName: 'notes',
	// Dynamically read the database name for the active profile
	get dbName() {
		const ws = AppState.activeWorkspace;
		if (!ws) {
			throw new Error("No active profile. Database locked.");
		}
		return ws.dbName;
	},

	init() {
		return new Promise((resolve, reject) => {
			const request = indexedDB.open(this.dbName, 1);
			request.onupgradeneeded = (e) => {
				const db = e.target.result;
				if (!db.objectStoreNames.contains(this.storeName)) {
					db.createObjectStore(this.storeName, { keyPath: 'filename' });
				}
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
	},
	async put(note) {
		const db = await this.init();
		return new Promise((resolve) => {
			const tx = db.transaction(this.storeName, 'readwrite');
			tx.objectStore(this.storeName).put(note);
			tx.oncomplete = () => resolve();
		});
	},
	async get(filename) {
		const db = await this.init();
		return new Promise((resolve) => {
			const tx = db.transaction(this.storeName, 'readonly');
			const request = tx.objectStore(this.storeName).get(filename);
			request.onsuccess = () => resolve(request.result);
		});
	},
	async getAll() {
		const db = await this.init();
		return new Promise((resolve) => {
			const tx = db.transaction(this.storeName, 'readonly');
			const request = tx.objectStore(this.storeName).getAll();
			request.onsuccess = () => resolve(request.result);
		});
	},
	async delete(filename) {
		const db = await this.init();
		return new Promise((resolve) => {
			const tx = db.transaction(this.storeName, 'readwrite');
			tx.objectStore(this.storeName).delete(filename);
			tx.oncomplete = () => resolve();
		});
	},
	async getAllKeys() {
		const db = await this.init();
		return new Promise((resolve) => {
			const tx = db.transaction(this.storeName, 'readonly');
			const request = tx.objectStore(this.storeName).getAllKeys();
			request.onsuccess = () => resolve(request.result);
		});
	},
	async clear() {
		const db = await this.init();
		return new Promise((resolve, reject) => {
			const tx = db.transaction(this.storeName, 'readwrite');
			tx.objectStore(this.storeName).clear();
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
	}
};

/* =====================================================================
			   5. GITHUB API SERVICE (Strictly Network Operations)
			===================================================================== */
const GitHubService = {
	/* =====================================================================
	   AUXILIARY HELPERS
	===================================================================== */

	// Internal API fetcher for clean error handling and boilerplate reduction
	async _apiFetch(url, token, options = {}) {
		const res = await fetch(url, {
			...options,
			headers: {
				'Authorization': `token ${token}`,
				'Accept': 'application/vnd.github.v3+json',
				...options.headers
			},
			cache: 'no-cache'
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
		const cleanRoot = (rootDir || '').replace(/^\/+|\/+$/g, '');
		const cleanFile = (filename || '').replace(/^\/+/, '');
		return cleanRoot ? `${cleanRoot}/${cleanFile}` : cleanFile;
	},

	/* =====================================================================
	   TREE OPERATIONS (From previous design)
	===================================================================== */

	async _getShallowTree(workspace, keychain) {
		const { host, owner, repo, branch, rootDir } = workspace;
		const safePath = (rootDir || '').replace(/^\/+|\/+$/g, '');

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
		const safePath = (rootDir || '').replace(/^\/+|\/+$/g, '');
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

		const isText = Utils.isTextFile(filename);

		// For text, we request standard JSON (Base64). For binaries, we request raw bytes.
		const headers = isText 
			? {} 
			: { 'Accept': 'application/vnd.github.raw' };

		const res = await this._apiFetch(url, keychain.token, { headers });

		// Handle Binary Files
		if (!isText) {
			const rawBlob = await res.blob();
			const ext = filename.split('.').pop().toLowerCase();

			let mimeType = 'application/octet-stream';
			if (Utils.isPdfFile(filename)) mimeType = 'application/pdf';
			else if (Utils.isImageFile(filename)) mimeType = `image/${ext}`;
			if (ext === 'svg') mimeType = 'image/svg+xml';
			if (ext === 'jpg') mimeType = 'image/jpeg';

			return new Blob([rawBlob], { type: mimeType });
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

/* =====================================================================
   5b. DROPBOX API SERVICE (VFS Architecture)
===================================================================== */
const DropboxService = {
	/* =====================================================================
	   AUXILIARY HELPERS
	===================================================================== */
	
	// Converts local filenames to absolute remote Dropbox paths
	_getFullPath(rootDir, filename = '') {
		const cleanRoot = (rootDir || '').replace(/(^\/+|\/+$)/g, '');
		const cleanFile = (filename || '').replace(/(^\/+|\/+$)/g, '');
		const combined = cleanRoot ? (cleanFile ? `${cleanRoot}/${cleanFile}` : cleanRoot) : cleanFile;
		return combined ? `/${combined}` : ''; // Dropbox strictly requires a leading slash, root is ""
	},

	// Slices the absolute Dropbox path back into a VFS relative path
	_stripRoot(rootDir, fullPath) {
		const rootPrefix = this._getFullPath(rootDir, '');
		if (!rootPrefix) return fullPath.substring(1); // Remove the leading slash
		return fullPath.substring(rootPrefix.length + 1); // +1 to drop the separator slash
	},

	_getHeaders(keychain, isContentEndpoint = false) {
		if (!keychain || !keychain.token) throw new Error('Dropbox token missing in keychain.');
		const headers = { 'Authorization': `Bearer ${keychain.token}` };

		// RPC calls MUST have application/json. Content calls MUST NOT.
		if (!isContentEndpoint) headers['Content-Type'] = 'application/json';
		else headers['Content-Type'] = 'application/octet-stream';
		
		return headers;
	},

	async _refreshAccessToken(keychain) {
		const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			cache: 'no-cache',
			body: new URLSearchParams({
				refresh_token: keychain.refreshToken,
				grant_type: 'refresh_token',
				client_id: keychain.appKey
			})
		});

		if (!res.ok) throw new Error('Dropbox session expired and refresh failed. Please re-link.');

		const data = await res.json();
		keychain.token = data.access_token;
		
		// Flush the mutated keychain reference directly to persistent storage
		localStorage.setItem('notes_keychains', JSON.stringify(AppState.keychains));
	},

	async _apiFetch(url, initOptions = {}, isContentEndpoint = false, customHeaders = {}, keychain) {
		const headers = this._getHeaders(keychain, isContentEndpoint);
		Object.assign(headers, customHeaders);

		// Dropbox /download strictly forbids Content-Type.
		if (url.includes('/download')) delete headers['Content-Type'];

		initOptions.headers = headers;
		initOptions.cache = 'no-cache';
		
		let res = await fetch(url, initOptions);

		// Intercept Auth Failures and Auto-Refresh
		if (res.status === 401 && keychain.refreshToken) {
			await this._refreshAccessToken(keychain);
			
			const retryHeaders = this._getHeaders(keychain, isContentEndpoint);
			Object.assign(retryHeaders, customHeaders);
			if (url.includes('/download')) delete retryHeaders['Content-Type'];
			
			initOptions.headers = retryHeaders;
			res = await fetch(url, initOptions);
		}
		
		return res;
	},

	/* =====================================================================
	   TREE OPERATIONS
	===================================================================== */
	
	async getTree(workspace, keychain) {
		let url = 'https://api.dropboxapi.com/2/files/list_folder';
		const targetPath = this._getFullPath(workspace.rootDir);
		
		let payload = { 
			path: targetPath, 
			recursive: !workspace.shallow, 
			limit: 1000 
		};
		
		let allEntries = [];
		let hasMore = true;

		while (hasMore) {
			const res = await this._apiFetch(url, { method: 'POST', body: JSON.stringify(payload) }, false, {}, keychain);
			
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				throw new Error(err.error_summary || 'Failed to fetch Dropbox folder tree.');
			}
			
			const data = await res.json();
			allEntries = allEntries.concat(data.entries);

			if (data.has_more) {
				url = 'https://api.dropboxapi.com/2/files/list_folder/continue';
				payload = { cursor: data.cursor };
			} else {
				hasMore = false;
			}
		}

		// VFS Mapping: Filter stubs, strip chroot prefixes, map types
		const tree = allEntries
			.filter(i => i['.tag'] === 'file' || (workspace.shallow && i['.tag'] === 'folder'))
			.map(i => ({ 
				path: this._stripRoot(workspace.rootDir, i.path_display), 
				sha: i.rev || i.id, // Dropbox folders lack a 'rev', substitute 'id' for the stub
				type: i['.tag'] === 'folder' ? 'folder' : 'blob',
				size: i.size || 0
			}));

		return { tree };
	},

	/* =====================================================================
	   FILE OPERATIONS
	===================================================================== */
	
	async getFile(filename, workspace, keychain) {
		const fullPath = this._getFullPath(workspace.rootDir, filename);
		const customHeaders = { 'Dropbox-API-Arg': JSON.stringify({ path: fullPath }) };
		
		const res = await this._apiFetch('https://content.dropboxapi.com/2/files/download', { method: 'POST' }, true, customHeaders, keychain);
		if (!res.ok) throw new Error("Failed to download file from Dropbox.");
		
		const rev = JSON.parse(res.headers.get('Dropbox-API-Result')).rev;
		
		if (!Utils.isTextFile(filename)) {
			const rawBlob = await res.blob();
			const ext = filename.split('.').pop().toLowerCase();

			let mimeType = 'application/octet-stream';
			if (Utils.isPdfFile(filename)) mimeType = 'application/pdf';
			else if (Utils.isImageFile(filename)) mimeType = `image/${ext}`;

			if (ext === 'svg') mimeType = 'image/svg+xml';
			if (ext === 'jpg') mimeType = 'image/jpeg';

			return new Blob([rawBlob], { type: mimeType });
		}

		return { content: Utils.utoa(await res.text()), sha: rev };
	},

	async putFile(filename, base64Content, sha, commitMsg, workspace, keychain) {
		const fullPath = this._getFullPath(workspace.rootDir, filename);
		const binaryString = atob(base64Content);
		
		const bytes = new Uint8Array(binaryString.length);
		for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);

		const customHeaders = {
			'Dropbox-API-Arg': JSON.stringify({
				path: fullPath,
				mode: sha ? { '.tag': 'update', update: sha } : { '.tag': 'add' },
				strict_conflict: true
			})
		};

		const res = await this._apiFetch('https://content.dropboxapi.com/2/files/upload', { 
			method: 'POST', 
			body: bytes 
		}, true, customHeaders, keychain);

		if (res.status === 409) throw new Error("Conflict: Remote has newer changes. Please Pull first.");
		if (!res.ok) {
			const err = await res.json().catch(() => ({}));
			throw new Error(err.error_summary || "Upload failed");
		}
		
		return { content: { sha: (await res.json()).rev } };
	},
	
	async deleteFile(filename, sha, workspace, keychain) {
		const fullPath = this._getFullPath(workspace.rootDir, filename);
		const url = 'https://api.dropboxapi.com/2/files/delete_v2';
		const payload = { path: fullPath };
		
		const res = await this._apiFetch(url, { method: 'POST', body: JSON.stringify(payload) }, false, {}, keychain);
		
		if (!res.ok && res.status !== 404 && res.status !== 409) {
			throw new Error("Dropbox deletion failed.");
		}
	},
	
	fileUploadSizeLimit() {
		return 150 * 1024 * 1024; // Standard 150MB un-chunked Dropbox limit
	}
};

const SyncService = {
    get active() {
        const ws = AppState.activeWorkspace;
        const kc = AppState.activeKeychain;
        if (!ws || !kc) throw new Error("Active workspace is missing a linked keychain.");
        return kc.provider === 'dropbox' ? DropboxService : GitHubService;
    },
    getTree: () => SyncService.active.getTree(AppState.activeWorkspace, AppState.activeKeychain),
    getFile: (filename) => SyncService.active.getFile(filename, AppState.activeWorkspace, AppState.activeKeychain),
    putFile: (filename, content, sha, commitMsg) => SyncService.active.putFile(filename, content, sha, commitMsg, AppState.activeWorkspace, AppState.activeKeychain),
    deleteFile: (filename, sha) => SyncService.active.deleteFile(filename, sha, AppState.activeWorkspace, AppState.activeKeychain),
    fileUploadSizeLimit: () => SyncService.active.fileUploadSizeLimit(),
};
