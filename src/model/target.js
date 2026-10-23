// Targets: one string naming a file or folder in any configured tree, used
// by the URL hash and by .symlink files.
//
//   <origin>:<path>     github:rust-lang/nomicon@master:src/intro.md
//                       github://ghe.example.com/api/v3/team/wiki@main:index.md
//                       rs:https://192.168.1.10:8765/storage:notes/a.md
//                       dropbox:Notes/todo.md
//   ./x  ../x  /x       relative to a link's folder, or its tree's root (symlinks only)
//
// The path is absolute in the tree, without a leading slash ('' is the root).
// Origin and path are split at the configured origin that the target starts
// with (the longest), never by parsing, so branches with '/' and paths with
// ':' need no escaping.
define('model/target', ['model/config', 'model/forest', 'lib/path'], (Config, Forest, Path) => {
	const GITHUB_API = 'https://api.github.com';

	const originOf = (ws, kc) => {
		const provider = kc ? kc.provider : 'github';
		const host = (ws.host || '').trim().replace(/\/+$/, '');
		if (provider === 'dropbox') return 'dropbox';
		if (provider === 'remotestorage') return `rs:${host}`;
		const repo = `${ws.owner}/${ws.repo}@${ws.branch}`;
		return !host || host === GITHUB_API ? `github:${repo}` : `github://${host.replace(/^https:\/\//, '')}/${repo}`;
	};

	// GitHub owner and repo are case-insensitive; the branch is not.
	const startsWithOrigin = (text, origin) => {
		if (text.length < origin.length) return false;
		const head = text.slice(0, origin.length);
		const exact = origin.startsWith('github') ? origin.lastIndexOf('@') : 0;
		return head.slice(0, exact).toLowerCase() === origin.slice(0, exact).toLowerCase()
			&& head.slice(exact) === origin.slice(exact)
			&& (text.length === origin.length || text[origin.length] === ':');
	};

	const isRelative = (text) => /^(\.\.?(\/|$)|\/)/.test(text);

	const Target = {
		originOf,

		// [{ origin, sig }] for every configured tree. Trees with the same origin
		// (several Dropbox keychains) resolve to the first.
		origins() {
			const seen = new Set();
			const list = [];
			for (const [sig, ids] of Object.entries(Forest.workspaceTrees())) {
				const ws = Config.workspaces[ids[0]];
				const origin = originOf(ws, Config.keychains[ws.keychainId]);
				if (seen.has(origin)) continue;
				seen.add(origin);
				list.push({ origin, sig });
			}
			return list;
		},

		// The target of a file (or, with no filename, the root) of a workspace.
		forWorkspace(workspaceId, filename = '') {
			const ws = Config.workspaces[workspaceId];
			const origin = originOf(ws, Config.keychains[ws.keychainId]);
			const path = Forest.getAbsolutePath(workspaceId, filename);
			return path ? `${origin}:${path}` : origin;
		},

		// For the URL hash: only what would break a URL is encoded.
		encode: (target) => encodeURI(target).replace(/[#?]/g, encodeURIComponent),
		decode(hash) {
			try { return decodeURIComponent(hash); } catch { return hash; }
		},

		// { workspaceId, filename } for a target, or { error }. `from` is the
		// { sig, path } of the .symlink holding a relative target.
		resolve(text, { from } = {}) {
			text = (text || '').trim();
			let sig, path;
			if (isRelative(text)) {
				if (!from) return { error: `A relative target ("${text}") only works in a symlink.` };
				path = Path.resolveWithin(from.path, text);
				if (path === null) return { error: `"${text}" goes above the repository root.` };
				sig = from.sig;
			} else {
				const match = Target.origins()
					.filter(o => startsWithOrigin(text, o.origin))
					.sort((a, b) => b.origin.length - a.origin.length)[0];
				if (!match) return { error: `No workspace for "${text}".` };
				sig = match.sig;
				path = Path.cleanPath(text.slice(match.origin.length + 1));
			}
			const workspaceId = Forest.resolveBestFit(path, sig);
			if (!workspaceId) return { error: `No workspace holds "${path}" in that repository.` };
			return { workspaceId, filename: Forest.getRelativePath(workspaceId, path) };
		},
	};

	return Target;
});
