// Facade over the provider of the active workspace's keychain.
//
// The provider contract. Each file has one version id ("sha": GitHub's git
// blob sha, Dropbox's rev, remoteStorage's ETag), and the same id appears in
// every call below, so the app only ever compares ids:
//
//   getTree(ws, kc)       -> { tree: [{ path, type: 'blob' | 'folder', sha, size }], truncated }
//                            Paths are relative to ws.rootDir. A shallow listing (ws.shallow)
//                            covers the top level only; truncated means entries are missing.
//   getFile(name, ws, kc) -> { content, sha }: base64 text, or a Blob for non-text files
//                            (FileTypes.isTextFile). sha identifies exactly these bytes;
//                            null only if the provider can't tell.
//   putFile(name, base64, sha, msg, ws, kc) -> { content: { sha } }, the new id.
//                            Conditional: replaces version sha, and fails if the remote
//                            has moved on; a null sha creates, and fails if the file
//                            exists. msg is a commit message, if any.
//   deleteFile(name, sha, ws, kc)
//                            Conditional on sha in the same way.
//                            A file already gone counts as deleted.
//   fileUploadSizeLimit() -> bytes
define('remote/sync', ['model/config', 'remote/github', 'remote/dropbox', 'remote/remotestorage'], (Config, GitHub, Dropbox, RemoteStorage) => {
	const providers = { github: GitHub, dropbox: Dropbox, remotestorage: RemoteStorage };

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
