define('lib/fileTypes', [], () => {
	const isImageFile = (filename) => /\.(png|jpg|jpeg|gif|svg|webp|ico)$/i.test(filename || '');
	const isPdfFile = (filename) => /\.pdf$/i.test(filename || '');
	const isMarkdownFile = (filename) => /\.(md|markdown)$/i.test(filename || '');
	const isSymlinkFile = (filename) => /\.symlink$/i.test(filename || '');

	const isTextFile = (filename) => {
		// Files with no extension are usually text (e.g., Makefile, .env)
		if (!filename.includes('.')) return true;
		// Add or remove extensions to this regex as needed
		return /\.(txt|md|markdown|rst|csv|json|xml|html|css|js|ts|jsx|tsx|py|yml|yaml|ini|env|sh|bat|m4|ps1|c|cpp|h|rs|go|java|toml|sml|gitignore|symlink)$/i.test(filename);
	};

	// Anything that is not text is transferred and stored as a Blob.
	const isBinaryFile = (filename) => !isTextFile(filename);

	// MIME type for a downloaded binary, so the image/PDF viewers can render it.
	const mimeTypeFor = (filename) => {
		const ext = filename.split('.').pop().toLowerCase();

		let mimeType = 'application/octet-stream';
		if (isPdfFile(filename)) mimeType = 'application/pdf';
		else if (isImageFile(filename)) mimeType = `image/${ext}`;
		if (ext === 'svg') mimeType = 'image/svg+xml';
		if (ext === 'jpg') mimeType = 'image/jpeg';
		return mimeType;
	};

	return { isImageFile, isPdfFile, isMarkdownFile, isSymlinkFile, isTextFile, isBinaryFile, mimeTypeFor };
});
