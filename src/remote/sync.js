// Facade over the provider of the active workspace's keychain.
define('remote/sync', ['model/config', 'remote/github', 'remote/dropbox'], (Config, GitHub, Dropbox) => {
	const providers = { github: GitHub, dropbox: Dropbox };

	const SyncService = {
		get active() {
			const ws = Config.activeWorkspace;
			const kc = Config.activeKeychain;
			if (!ws || !kc) throw new Error("Active workspace is missing a linked keychain.");
			return providers[kc.provider] || GitHub;
		},
		getTree: () => SyncService.active.getTree(Config.activeWorkspace, Config.activeKeychain),
		getFile: (filename) => SyncService.active.getFile(filename, Config.activeWorkspace, Config.activeKeychain),
		putFile: (filename, content, sha, commitMsg) => SyncService.active.putFile(filename, content, sha, commitMsg, Config.activeWorkspace, Config.activeKeychain),
		deleteFile: (filename, sha) => SyncService.active.deleteFile(filename, sha, Config.activeWorkspace, Config.activeKeychain),
		fileUploadSizeLimit: () => SyncService.active.fileUploadSizeLimit(),
	};

	return SyncService;
});
