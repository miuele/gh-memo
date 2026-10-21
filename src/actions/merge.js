// Conflict markers for a pull that collides with local edits.
define('actions/merge', [], () => ({
	// Line diff based markers. `Diff` is the jsdiff library.
	// Known issue: jsdiff emits removals before additions, so the markers come
	// out unbalanced; see review.md §1.6. Kept as-is by the module refactor.
	diffMarkers(Diff, remoteContent, localContent) {
		let merged = "";
		Diff.diffLines(remoteContent, localContent).forEach(p => {
			if (p.added) merged += `<<<<<<< LOCAL\n${p.value}\n=======\n`;
			else if (p.removed) merged += `${p.value}>>>>>>> REMOTE\n`;
			else merged += p.value;
		});
		return merged;
	},

	// Fallback when the diff engine isn't available: the whole file on each side.
	wholeFileMarkers(remoteContent, localContent) {
		return `<<<<<<< LOCAL\n${localContent}\n=======\n${remoteContent}\n>>>>>>> REMOTE`;
	},
}));
