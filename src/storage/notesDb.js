// Local note cache: one IndexedDB database per workspace (workspace.dbName),
// holding one record per file: { filename, content, last_synced_sha, remote_sha, is_dirty, is_folder }.
define('storage/notesDb', ['model/config'], (Config) => {
	const DBService = {
		storeName: 'notes',

		// Cache of open IDBDatabase promises keyed by db name.
		// Reusing a single connection per database is the correct IDB pattern —
		// calling indexedDB.open() on every operation creates unnecessary overhead.
		_dbCache: {},

		// Ceiling for any single local IndexedDB operation — opening the
		// connection, or a get/put/delete/etc request within it.
		//
		// Unlike fetch()'s AbortController, an IDBRequest has no abort()/cancel();
		// a "timeout" here can't literally cancel the underlying browser-internal
		// request. What it CAN do is stop the app from awaiting it forever,
		// surface a clear error instead of a silent hang, and evict the cached
		// connection so the next attempt opens a fresh one instead of re-awaiting
		// a request that may never settle. This matters because Chrome on Android
		// has a known behavior where a backgrounded/frozen PWA can leave an
		// in-flight IndexedDB request permanently pending after the page resumes
		// — and since _dbCache reuses one Promise per db name, a single wedged
		// open() previously poisoned every future read/write for that workspace
		// until a full reload.
		DB_TIMEOUT_MS: 8000,

		// Races `promise` against a timer. Whichever settles first wins; the
		// loser is left to resolve/reject into the void (IDB gives us no way to
		// actually cancel it).
		_guardWithTimeout(promise, label) {
			let timer;
			const timeout = new Promise((_, reject) => {
				timer = setTimeout(() => {
					reject(new Error(`${label} timed out. If this keeps happening, try reloading the app.`));
				}, this.DB_TIMEOUT_MS);
			});
			return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
		},

		// Dynamically read the database name for the active profile
		get dbName() {
			const ws = Config.activeWorkspace;
			if (!ws) {
				throw new Error("No active profile. Database locked.");
			}
			return ws.dbName;
		},

		init() {
			const name = this.dbName;
			if (this._dbCache[name]) return this._dbCache[name];

			const openPromise = new Promise((resolve, reject) => {
				const request = indexedDB.open(name, 1);
				request.onupgradeneeded = (e) => {
					const db = e.target.result;
					if (!db.objectStoreNames.contains(this.storeName)) {
						db.createObjectStore(this.storeName, { keyPath: 'filename' });
					}
				};
				request.onsuccess = () => {
					const db = request.result;
					// If another context deletes this database (e.g. deleteWorkspace),
					// close the connection and evict the cache so the next init()
					// opens a fresh handle rather than using a stale one.
					db.onversionchange = () => {
						db.close();
						delete this._dbCache[name];
					};
					resolve(db);
				};
				request.onerror = () => reject(request.error);
			});

			const guarded = this._guardWithTimeout(openPromise, `Opening local database`);

			// On timeout OR a native open() error, evict the cache entry so the
			// next init() call starts a fresh indexedDB.open() rather than
			// re-awaiting this same (possibly forever-pending) request. Guard
			// against a race with a later attempt already having replaced us.
			guarded.catch(() => {
				if (this._dbCache[name] === guarded) delete this._dbCache[name];
			});

			this._dbCache[name] = guarded;
			return guarded;
		},

		// Runs a single IDB operation against the open db handle, under the same
		// timeout guard as init(). On failure, evicts the cached connection too —
		// a wedged transaction is a strong signal the connection itself is dead,
		// so the best recovery is a fresh indexedDB.open() on the next call.
		async _run(executor, label) {
			const name = this.dbName;
			const db = await this.init();
			try {
				return await this._guardWithTimeout(executor(db), label);
			} catch (err) {
				delete this._dbCache[name];
				throw err;
			}
		},

		async put(note) {
			return this._run(db => new Promise((resolve, reject) => {
				const tx = db.transaction(this.storeName, 'readwrite');
				tx.objectStore(this.storeName).put(note);
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
				tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
			}), 'Saving note');
		},
		async get(filename) {
			return this._run(db => new Promise((resolve, reject) => {
				const tx = db.transaction(this.storeName, 'readonly');
				const request = tx.objectStore(this.storeName).get(filename);
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			}), 'Reading note');
		},
		async getAll() {
			return this._run(db => new Promise((resolve, reject) => {
				const tx = db.transaction(this.storeName, 'readonly');
				const request = tx.objectStore(this.storeName).getAll();
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			}), 'Reading notes');
		},
		async delete(filename) {
			return this._run(db => new Promise((resolve, reject) => {
				const tx = db.transaction(this.storeName, 'readwrite');
				tx.objectStore(this.storeName).delete(filename);
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
				tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
			}), 'Deleting note');
		},
		async getAllKeys() {
			return this._run(db => new Promise((resolve, reject) => {
				const tx = db.transaction(this.storeName, 'readonly');
				const request = tx.objectStore(this.storeName).getAllKeys();
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			}), 'Reading note list');
		},
		async clear() {
			return this._run(db => new Promise((resolve, reject) => {
				const tx = db.transaction(this.storeName, 'readwrite');
				tx.objectStore(this.storeName).clear();
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
				tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
			}), 'Clearing local cache');
		}
	};

	return DBService;
});
