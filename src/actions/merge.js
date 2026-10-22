// Conflict markers for a pull that collides with local edits.
define('actions/merge', [], () => ({
	// Line diff based markers. `Diff` is the jsdiff library. Each run of
	// changed lines becomes one hunk, local side first as in git:
	//
	//     <<<<<<< LOCAL
	//     (local lines)
	//     =======
	//     (remote lines)
	//     >>>>>>> REMOTE
	//
	// Either side may be empty (a line added or deleted on one side only).
	diffMarkers(Diff, remoteContent, localContent) {
		const asLines = (text) => text && !text.endsWith('\n') ? text + '\n' : text;
		let merged = '';
		let local = '';
		let remote = '';
		let inHunk = false;
		const closeHunk = () => {
			if (!inHunk) return;
			merged += `<<<<<<< LOCAL\n${asLines(local)}=======\n${asLines(remote)}>>>>>>> REMOTE\n`;
			local = remote = '';
			inHunk = false;
		};

		// diffLines(remote, local): "removed" is remote-only, "added" local-only.
		for (const part of Diff.diffLines(remoteContent, localContent)) {
			if (part.added) local += part.value;
			else if (part.removed) remote += part.value;
			else {
				closeHunk();
				merged += part.value;
				continue;
			}
			inHunk = true;
		}
		closeHunk();
		return merged;
	},

	// Fallback when the diff engine isn't available: the whole file on each side.
	wholeFileMarkers(remoteContent, localContent) {
		return `<<<<<<< LOCAL\n${localContent}\n=======\n${remoteContent}\n>>>>>>> REMOTE`;
	},
}));
