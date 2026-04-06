const DBService = {
	storeName: 'notes',
	// Dynamically read the database name for the active profile
	get dbName() {
		if (!AppState.activeProfileId || !AppState.profiles[AppState.activeProfileId]) {
			throw new Error("No active profile. Database locked.");
		}
		return AppState.profiles[AppState.activeProfileId].dbName;
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
	getHeaders() {
		if (!AppState.config.token) throw new Error('GitHub token not configured.');
		return {
			'Authorization': `token ${AppState.config.token}`,
			'Accept': 'application/vnd.github.v3+json',
			'Content-Type': 'application/json'
		};
	},
	async getTree() {
		const { host, owner, repo, branch } = AppState.config;
		const url = `${host}/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
		const res = await fetch(url, { headers: this.getHeaders(), cache: 'no-store' });
		if (!res.ok) throw new Error('Failed to fetch repository tree.');
		return await res.json();
	},
	async getFile(filename) {
		const { host, owner, repo } = AppState.config;
		const url = `${host}/repos/${owner}/${repo}/contents/${filename}`;
		const isImage = Utils.isImageFile(filename);
		const isPdf = Utils.isPdfFile(filename);

		const headers = this.getHeaders();
		if (!Utils.isTextFile(filename)) headers['Accept'] = 'application/vnd.github.raw';

		const res = await fetch(url, { headers, cache: 'no-store' });
		if (!res.ok) throw new Error('Failed to fetch file. It may have been deleted remotely.');

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

		return await res.json();
	},
	async putFile(filename, contentBase64, sha) {
		const { host, owner, repo, branch } = AppState.config;
		const url = `${host}/repos/${owner}/${repo}/contents/${filename}`;
		const payload = { message: `Update ${filename}`, content: contentBase64, branch: branch };
		if (sha) payload.sha = sha;

		const res = await fetch(url, {
			method: 'PUT',
			headers: this.getHeaders(),
			body: JSON.stringify(payload)
		});
		if (res.status === 409) throw new Error(`Remote has newer changes. Please Pull first.`);
		if (!res.ok) throw new Error(`Failed to push file.`);
		return await res.json();
	},
	async deleteFile(filename, sha) {
		const { host, owner, repo, branch } = AppState.config;
		const url = `${host}/repos/${owner}/${repo}/contents/${filename}`;
		const payload = { message: `Delete note: ${filename}`, sha: sha, branch: branch };

		const res = await fetch(url, {
			method: 'DELETE',
			headers: this.getHeaders(),
			body: JSON.stringify(payload)
		});
		if (!res.ok && res.status !== 404) {
			const errorData = await res.json();
			throw new Error(errorData.message || "GitHub deletion failed.");
		}
	},
	fileUploadSizeLimit() {
		return 10 * 1024 * 1024;
	}
};

/* =====================================================================
			   5b. DROPBOX API SERVICE
			===================================================================== */
const DropboxService = {
	getHeaders(isContentEndpoint = false) {
		if (!AppState.config.token) throw new Error('Dropbox token missing.');
		const headers = { 'Authorization': `Bearer ${AppState.config.token}` };

		// RPC calls (like list_folder) MUST have application/json
		// Content calls (upload/download) MUST NOT have application/json
		if (!isContentEndpoint) {
			headers['Content-Type'] = 'application/json';
		} else {
			headers['Content-Type'] = 'application/octet-stream';
		}
		return headers;
	},

	formatPath(filename) { return filename.startsWith('/') ? filename : `/${filename}`; },

	async apiFetch(url, initOptions = {}, isContentEndpoint = false, customHeaders = {}) {
		const headers = this.getHeaders(isContentEndpoint);
		Object.assign(headers, customHeaders);

		// STALKER FIX: Dropbox /download strictly forbids Content-Type.
		if (url.includes('/download')) delete headers['Content-Type'];

		initOptions.headers = headers;
		initOptions.cache = 'no-store';
		let res = await fetch(url, initOptions);

		if (res.status === 401 && AppState.config.refreshToken) {
			await this.refreshAccessToken();
			const retryHeaders = this.getHeaders(isContentEndpoint);
			Object.assign(retryHeaders, customHeaders);
			if (url.includes('/download')) delete retryHeaders['Content-Type'];
			initOptions.headers = retryHeaders;
			res = await fetch(url, initOptions);
		}
		return res;
	},

	async refreshAccessToken() {
		const { appKey, refreshToken } = AppState.config;

		const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			cache: 'no-store',
			body: new URLSearchParams({
				refresh_token: refreshToken,
				grant_type: 'refresh_token',
				client_id: appKey
			})
		});

		if (!res.ok) throw new Error('Refresh failed.');

		const data = await res.json();
		AppState.config.token = data.access_token;
		AppState.profiles[AppState.activeProfileId].config = AppState.config;
		localStorage.setItem('notes_profiles', JSON.stringify(AppState.profiles));
	},

	async getTree() {
		let url = 'https://api.dropboxapi.com/2/files/list_folder';
		let payload = { path: "", recursive: true, limit: 1000 };
		let allEntries = [];
		let hasMore = true;

		while (hasMore) {
			const res = await this.apiFetch(url, { method: 'POST', body: JSON.stringify(payload) });
			if (!res.ok) throw new Error('Failed to fetch Dropbox folder tree.');
			const data = await res.json();
			allEntries = allEntries.concat(data.entries);

			if (data.has_more) {
				url = 'https://api.dropboxapi.com/2/files/list_folder/continue';
				payload = { cursor: data.cursor };
			} else hasMore = false;
		}

		return { 
			tree: allEntries.filter(i => i['.tag'] === 'file').map(i => ({ 
				path: i.path_display.substring(1), 
				sha: i.rev, 
				type: 'blob',
				size: i.size
			})) 
		};
	},

	async getFile(filename) {
		const customHeaders = { 'Dropbox-API-Arg': JSON.stringify({ path: this.formatPath(filename) }) };
		const res = await this.apiFetch('https://content.dropboxapi.com/2/files/download', { method: 'POST' }, true, customHeaders);
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

	async putFile(filename, base64Content, sha) {
		const binaryString = atob(base64Content);
		const bytes = new Uint8Array(binaryString.length);
		for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);

		const customHeaders = {
			'Dropbox-API-Arg': JSON.stringify({
				path: this.formatPath(filename),
				mode: sha ? { '.tag': 'update', update: sha } : { '.tag': 'add' },
				strict_conflict: true
			})
		};

		const res = await this.apiFetch('https://content.dropboxapi.com/2/files/upload', { 
			method: 'POST', 
			body: bytes 
		}, true, customHeaders);

		if (res.status === 409) throw new Error("Conflict: Pull first.");
		if (!res.ok) {
			const err = await res.json();
			throw new Error(err.error_summary || "Upload failed");
		}
		return { content: { sha: (await res.json()).rev } };
	},
	async deleteFile(filename) {
		const url = 'https://api.dropboxapi.com/2/files/delete_v2';
		const payload = { path: this.formatPath(filename) };
		const res = await this.apiFetch(url, { method: 'POST', body: JSON.stringify(payload) });
		if (!res.ok && res.status !== 404) throw new Error("Dropbox deletion failed.");
	},
	fileUploadSizeLimit() {
		return 200 * 1024 * 1024;
	}
};
const SyncService = {
	get active() {
		return AppState.config.provider === 'dropbox' ? DropboxService : GitHubService;
	},
	getTree: () => SyncService.active.getTree(),
	getFile: (filename) => SyncService.active.getFile(filename),
	putFile: (filename, content, sha) => SyncService.active.putFile(filename, content, sha),
	deleteFile: (filename, sha) => SyncService.active.deleteFile(filename, sha),
	fileUploadSizeLimit: () => SyncService.active.fileUploadSizeLimit(),
};
