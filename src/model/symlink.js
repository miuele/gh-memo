// Declarative symlinks: a .symlink file holds JSON naming a target workspace,
// e.g. { "owner": "rust-lang", "repo": "nomicon", "rootDir": "src" }.
define('model/symlink', ['lib/path'], (Path) => {
	const MATCHABLE_FIELDS = ['provider', 'host', 'owner', 'repo', 'branch', 'rootDir'];

	return {
		// Parses symlink content. Throws on malformed JSON.
		parse(content) {
			return JSON.parse(content || '{}');
		},

		// The payload keys that take part in matching.
		matchableKeys(payload) {
			return Object.keys(payload).filter(k => MATCHABLE_FIELDS.includes(k));
		},

		// Ids of every workspace whose fields equal the payload on all matchable keys.
		findTargets(payload, workspaces) {
			const payloadKeys = this.matchableKeys(payload);
			return Object.keys(workspaces).filter(id => {
				const wsTarget = workspaces[id];
				return payloadKeys.every(key => {
					if (key === 'rootDir') {
						return Path.cleanPath(wsTarget.rootDir) === Path.cleanPath(payload.rootDir);
					}
					return wsTarget[key] === payload[key];
				});
			});
		},
	};
});
