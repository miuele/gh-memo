// The plugin host: how a plugin instance reads files besides its own.
//
// It reads stored files of the open file's repository (forest tree: same
// repo and branch), as of the workspace that was active at mount time:
// never for writing, never from the network. Paths are relative to the
// open file (or start at the repo root with '/'). They may cross mount
// points, but not go above the repo root, and .symlink files are never
// followed. Every file read is watched, so the plugin hears when it changes.
//
//   const host = Host.create(filename);
//   host.api       // { read(path), onChange(cb) }, handed to the plugin's mount
//   host.reads()   // the paths read so far, for the app
//   host.dispose() // on unmount
define('actions/host', ['model/config', 'model/forest', 'lib/path', 'storage/notesDb'], (Config, Forest, Path, DBService) => {
	const COALESCE_MS = 250;

	// Hosts of mounted plugins, told about writes made in other tabs.
	const live = new Set();

	// The form a path is resolved in: trimmed and percent-decoded, so
	// 'my%20pic.png' and 'my pic.png' are the same file.
	const normalize = (path) => {
		const s = String(path).trim();
		try { return decodeURIComponent(s); } catch { return s; }
	};
	// URLs, protocol-relative links and anchors are not paths.
	const isExternal = (path) => !path || /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(path);

	const Host = {
		COALESCE_MS,

		create(filename) {
			const wsId = Config.activeWorkspaceId;
			const ws = Config.workspaces[wsId];
			const sig = ws ? Forest.computeTreeSig(ws, Config.keychains[ws.keychainId]) : null;
			const selfPath = Forest.getAbsolutePath(wsId, filename);

			let disposed = false;
			const listeners = new Set();
			const pending = new Set();
			let timer = null;
			// Paths read so far: path -> where it was looked up ({ dbName, filename } or null).
			const watched = new Map();

			// A path -> { dbName, filename } of the deepest workspace of the tree
			// that holds it, or null when none does. Throws for a path above the
			// repo root or through a .symlink.
			const resolve = (path) => {
				if (isExternal(path)) throw new Error(`${path} is not a path in the repository`);
				const absolutePath = Path.resolveWithin(selfPath, path);
				if (absolutePath === null) throw new Error(`${path} is outside the repository`);
				if (absolutePath.split('/').some(part => /\.symlink$/i.test(part))) throw new Error(`${path}: symlinks are not followed`);
				if (!sig) return null;
				const id = Forest.resolveBestFit(absolutePath, sig);
				if (!id) return null;
				const relative = Forest.getRelativePath(id, absolutePath);
				return relative ? { dbName: Config.workspaces[id].dbName, filename: relative } : null;
			};

			const notify = (paths) => {
				if (disposed || !paths.length) return;
				paths.forEach(p => pending.add(p));
				if (timer) return;
				timer = setTimeout(() => {
					timer = null;
					if (disposed) return;
					const changed = [...pending];
					pending.clear();
					for (const cb of [...listeners]) {
						try { cb({ paths: changed }); } catch (err) { console.error(err); }
					}
				}, COALESCE_MS);
			};

			// A stored file changed (this tab or another): was it read here?
			// Mounts are looked up again, since one may have been added since.
			const written = ({ dbName, filename: changed }) => {
				const hit = [];
				for (const path of watched.keys()) {
					let target;
					try { target = resolve(path); } catch { continue; }
					watched.set(path, target);
					if (target && target.dbName === dbName && (changed === null || target.filename === changed)) hit.push(path);
				}
				notify(hit);
			};

			const api = Object.freeze({
				// The stored copy: { content, isDirty } (text as a string, binary as
				// a Blob), or null if it isn't stored here.
				async read(path) {
					if (disposed) return null;
					const key = normalize(path);
					const target = resolve(key);
					watched.set(key, target);
					if (!target) return null;
					const note = await DBService.get(target.filename, target.dbName);
					if (disposed || !note || note.is_folder) return null;
					return { content: note.content, isDirty: !!note.is_dirty };
				},

				// cb({ paths }) when files read through this host change in the
				// local store. Returns an unsubscribe function.
				onChange(cb) {
					if (disposed) return () => {};
					listeners.add(cb);
					return () => listeners.delete(cb);
				},
			});

			const unsubscribe = DBService.onWrite(written);

			const host = {
				api,
				written,
				reads: () => [...watched.keys()],

				dispose() {
					if (disposed) return;
					disposed = true;
					clearTimeout(timer);
					listeners.clear();
					pending.clear();
					unsubscribe();
					live.delete(host);
				},
			};
			live.add(host);
			return host;
		},

		// A write made in another tab (app/crossTab forwards them).
		changed(dbName, filename) {
			for (const host of [...live]) host.written({ dbName, filename });
		},
	};

	return Host;
});
