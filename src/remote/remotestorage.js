// remoteStorage provider (draft-dejong-remotestorage), strictly network
// operations. Works with any remoteStorage server: the workspace's `host` is
// the storage URL and the keychain holds a bearer token. No extensions are
// used, so a refresh walks the folders, skipping any whose ETag is unchanged.
define('remote/remotestorage', ['lib/net', 'lib/path', 'lib/fileTypes', 'lib/encoding'], (Net, Path, FileTypes, Encoding) => {
	// Folder listings seen this session, keyed by folder URL:
	// { etag, entries } where entries is the deep listing below that folder.
	const folderCache = new Map();

	const RemoteStorageService = {
		/* =====================================================================
		   AUXILIARY HELPERS
		===================================================================== */

		// The storage URL with exactly one trailing slash.
		_storageUrl(workspace) {
			const url = (workspace.host || '').trim().replace(/\/+$/, '');
			if (!/^https?:\/\//.test(url)) throw new Error('Set the storage URL (https://…/storage/) for this remoteStorage workspace.');
			return url + '/';
		},

		// Each path segment is encoded on its own, as in remote/github (C5).
		_encodePath(path) {
			return Path.cleanPath(path).split('/').filter(Boolean).map(encodeURIComponent).join('/');
		},

		_docUrl(workspace, filename) {
			const root = Path.cleanPath(workspace.rootDir);
			const full = root ? `${root}/${filename}` : filename;
			return this._storageUrl(workspace) + this._encodePath(full);
		},

		_folderUrl(workspace, folder) {
			const encoded = this._encodePath(folder);
			return this._storageUrl(workspace) + (encoded ? encoded + '/' : '');
		},

		// Strong or weak, quoted or not: the bare version string.
		_etag(res) {
			const raw = res.headers.get('ETag');
			return raw ? raw.replace(/^W\//, '').replace(/^"|"$/g, '') : null;
		},

		// remoteStorage defines status codes but not error bodies, so the message
		// comes from the status; a server's own message is appended when present.
		async _error(res) {
			const body = await res.json().catch(() => ({}));
			const detail = body && body.message ? ` (${body.message})` : '';
			const messages = {
				401: 'remoteStorage rejected the token. Check the keychain.',
				403: 'Access denied by the remoteStorage server.',
				404: 'Not found on the remoteStorage server.',
				409: 'Path conflict: a folder name clashes with a file on the server.',
				412: 'Conflict: Remote has newer changes. Please Pull first.',
				413: 'File too large for the remoteStorage server.',
				429: 'Too many requests. Try again in a minute.',
				507: 'The remoteStorage account is over its quota.',
			};
			return new Error((messages[res.status] || `remoteStorage error: ${res.status}`) + detail);
		},

		_fetch(url, keychain, options = {}) {
			if (!keychain || !keychain.token) throw new Error('Missing token in keychain.');
			return Net.fetchWithTimeout(url, {
				...options,
				headers: { 'Authorization': `Bearer ${keychain.token}`, ...options.headers },
				cache: 'no-store',
			});
		},

		/* =====================================================================
		   TREE OPERATIONS
		===================================================================== */

		// One folder listing, revalidated with If-None-Match when we have seen it.
		// Returns { etag, items, cached } where cached means the server said 304.
		async _listFolder(url, keychain) {
			const known = folderCache.get(url);
			const headers = known && known.etag ? { 'If-None-Match': `"${known.etag}"` } : {};
			const res = await this._fetch(url, keychain, { headers });
			if (res.status === 304 && known) return { ...known, cached: true };
			if (res.status === 404) return { etag: null, items: {}, cached: false };   // empty folders are often 404
			if (!res.ok) throw await this._error(res);
			const body = await res.json();
			return { etag: this._etag(res), items: (body && body.items) || {}, cached: false };
		},

		// The deep listing below a folder, relative to it. A subfolder whose ETag
		// in the parent listing equals the one we cached is reused without a request.
		async _walk(url, keychain, knownEtag) {
			const known = folderCache.get(url);
			if (known && knownEtag && known.etag === knownEtag) return known.entries;

			const listing = await this._listFolder(url, keychain);
			if (listing.cached) return listing.entries;

			const entries = [];
			for (const [name, item] of Object.entries(listing.items)) {
				if (name.endsWith('/')) {
					const sub = name.slice(0, -1);
					const below = await this._walk(url + encodeURIComponent(sub) + '/', keychain, item.ETag);
					for (const e of below) entries.push({ ...e, path: `${sub}/${e.path}` });
				} else {
					entries.push({ path: name, sha: item.ETag, type: 'blob', size: item['Content-Length'] || 0 });
				}
			}
			folderCache.set(url, { etag: listing.etag, items: listing.items, entries });
			return entries;
		},

		async getTree(workspace, keychain) {
			const url = this._folderUrl(workspace, workspace.rootDir);

			if (workspace.shallow) {
				const listing = await this._listFolder(url, keychain);
				const tree = Object.entries(listing.items).map(([name, item]) => name.endsWith('/')
					? { path: name.slice(0, -1), sha: item.ETag, type: 'folder', size: 0 }
					: { path: name, sha: item.ETag, type: 'blob', size: item['Content-Length'] || 0 });
				return { tree, truncated: false };
			}

			return { tree: await this._walk(url, keychain, null), truncated: false };
		},

		/* =====================================================================
		   FILE OPERATIONS
		===================================================================== */

		async getFile(filename, workspace, keychain) {
			const res = await this._fetch(this._docUrl(workspace, filename), keychain);
			if (!res.ok) throw await this._error(res);

			if (!FileTypes.isTextFile(filename)) {
				const rawBlob = await res.blob();
				return new Blob([rawBlob], { type: FileTypes.mimeTypeFor(filename) });
			}
			return { content: Encoding.utoa(await res.text()), sha: this._etag(res) };
		},

		async putFile(filename, base64Content, sha, commitMsg, workspace, keychain) {
			const binaryString = atob(base64Content);
			const bytes = new Uint8Array(binaryString.length);
			for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);

			// Always conditional: update only the version we last saw, or create only if absent.
			const res = await this._fetch(this._docUrl(workspace, filename), keychain, {
				method: 'PUT',
				headers: {
					'Content-Type': FileTypes.isTextFile(filename) ? 'text/plain; charset=utf-8' : FileTypes.mimeTypeFor(filename),
					...(sha ? { 'If-Match': `"${sha}"` } : { 'If-None-Match': '*' }),
				},
				body: bytes,
			});
			if (!res.ok) throw await this._error(res);

			const newSha = this._etag(res);
			if (!newSha) throw new Error('The server did not return an ETag. Check that its CORS settings expose ETag.');
			return { content: { sha: newSha } };
		},

		async deleteFile(filename, sha, workspace, keychain) {
			const res = await this._fetch(this._docUrl(workspace, filename), keychain, {
				method: 'DELETE',
				headers: sha ? { 'If-Match': `"${sha}"` } : {},
			});
			if (!res.ok && res.status !== 404) throw await this._error(res);
		},

		fileUploadSizeLimit() {
			return 100 * 1024 * 1024; // remoteStorage has no way to ask; servers answer 413 above their limit
		},

		// For tests: forget the folder listings seen so far.
		_resetCache() { folderCache.clear(); },
	};

	return RemoteStorageService;
});
