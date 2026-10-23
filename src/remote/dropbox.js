// Dropbox API provider. Every method takes the workspace and keychain explicitly;
// an expired access token is refreshed and persisted transparently.
define('remote/dropbox', ['lib/net', 'lib/path', 'lib/fileTypes', 'lib/encoding', 'model/config'], (Net, Path, FileTypes, Encoding, Config) => {
	const DropboxService = {
		/* =====================================================================
		   AUXILIARY HELPERS
		===================================================================== */
		
		// Converts local filenames to absolute remote Dropbox paths
		_getFullPath(rootDir, filename = '') {
			const cleanRoot = Path.cleanPath(rootDir);
			const cleanFile = Path.cleanPath(filename);
			const combined = cleanRoot ? (cleanFile ? `${cleanRoot}/${cleanFile}` : cleanRoot) : cleanFile;
			return combined ? `/${combined}` : ''; // Dropbox strictly requires a leading slash; root is ""
		},

		// Slices the absolute Dropbox path back into a VFS relative path
		_stripRoot(rootDir, fullPath) {
			const rootPrefix = this._getFullPath(rootDir, '');
			if (!rootPrefix) return fullPath.substring(1); // Remove the leading slash
			return fullPath.substring(rootPrefix.length + 1); // +1 to drop the separator slash
		},

		_toHeaderSafeJson(obj) {
		    return JSON.stringify(obj).replace(/[^\x00-\x7f]/g, (c) => {
		        return "\\u" + ("000" + c.charCodeAt(0).toString(16)).slice(-4);
		    });
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
			const res = await Net.fetchWithTimeout('https://api.dropboxapi.com/oauth2/token', {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				cache: 'no-store',
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
			Config.saveKeychains();
		},

		async _apiFetch(url, initOptions = {}, isContentEndpoint = false, customHeaders = {}, keychain) {
			const headers = this._getHeaders(keychain, isContentEndpoint);
			Object.assign(headers, customHeaders);

			// Dropbox /download strictly forbids Content-Type.
			if (url.includes('/download')) delete headers['Content-Type'];

			initOptions.headers = headers;
			initOptions.cache = 'no-store';
			
			let res = await Net.fetchWithTimeout(url, initOptions);

			// Intercept Auth Failures and Auto-Refresh
			if (res.status === 401 && keychain.refreshToken) {
				await this._refreshAccessToken(keychain);
				
				const retryHeaders = this._getHeaders(keychain, isContentEndpoint);
				Object.assign(retryHeaders, customHeaders);
				if (url.includes('/download')) delete retryHeaders['Content-Type'];
				
				initOptions.headers = retryHeaders;
				res = await Net.fetchWithTimeout(url, initOptions);
			}
			
			return res;
		},

		// Dropbox answers every endpoint-specific error with 409 and names it in
		// error_summary (e.g. "path/conflict/file/..", "path/insufficient_space/..").
		// Only a conflict means the remote moved on; the rest are reported as they are.
		async _endpointError(res, fallback) {
			const err = await res.json().catch(() => ({}));
			const summary = err.error_summary || '';
			if (res.status === 409 && /(^|\/)conflict\//.test(summary)) return new Error("Conflict: Remote has newer changes. Please Pull first.");
			return new Error(summary ? `Dropbox: ${summary.replace(/\/+\.*$/, '')}` : fallback);
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
			const customHeaders = { 'Dropbox-API-Arg': this._toHeaderSafeJson({ path: fullPath }) };
			
			const res = await this._apiFetch('https://content.dropboxapi.com/2/files/download', { method: 'POST' }, true, customHeaders, keychain);
			if (!res.ok) throw new Error("Failed to download file from Dropbox.");
			
			const rev = JSON.parse(res.headers.get('Dropbox-API-Result')).rev;
			
			if (!FileTypes.isTextFile(filename)) {
				const rawBlob = await res.blob();
				return { content: new Blob([rawBlob], { type: FileTypes.mimeTypeFor(filename) }), sha: rev };
			}

			return { content: Encoding.utoa(await res.text()), sha: rev };
		},

		async putFile(filename, base64Content, sha, commitMsg, workspace, keychain) {
			const fullPath = this._getFullPath(workspace.rootDir, filename);
			const binaryString = atob(base64Content);
			
			const bytes = new Uint8Array(binaryString.length);
			for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);

			const customHeaders = {
				'Dropbox-API-Arg': this._toHeaderSafeJson({
					path: fullPath,
					mode: sha ? { '.tag': 'update', update: sha } : { '.tag': 'add' },
					strict_conflict: true
				})
			};

			const res = await this._apiFetch('https://content.dropboxapi.com/2/files/upload', { 
				method: 'POST', 
				body: bytes 
			}, true, customHeaders, keychain);

			if (!res.ok) throw await this._endpointError(res, "Upload failed");
			
			return { content: { sha: (await res.json()).rev } };
		},
		
		async deleteFile(filename, sha, workspace, keychain) {
			const fullPath = this._getFullPath(workspace.rootDir, filename);
			const url = 'https://api.dropboxapi.com/2/files/delete_v2';
			// parent_rev: delete only if the file is still at the synced version.
			const payload = sha ? { path: fullPath, parent_rev: sha } : { path: fullPath };

			const res = await this._apiFetch(url, { method: 'POST', body: JSON.stringify(payload) }, false, {}, keychain);
			if (res.ok || res.status === 404) return;

			// A file that is already gone counts as deleted.
			const error = await this._endpointError(res, "Dropbox deletion failed.");
			if (res.status === 409 && /path_lookup\/not_found/.test(error.message)) return;
			throw error;
		},
		
		fileUploadSizeLimit() {
			return 150 * 1024 * 1024; // Standard 150MB un-chunked Dropbox limit
		}
	};

	return DropboxService;
});
