// A .symlink file holds one target (model/target) as plain text, e.g.
// "github:rust-lang/nomicon@master:src" or "../guide/intro.md".
define('model/symlink', [], () => ({
	// The target: the first non-empty line, trimmed ('' if there is none).
	target(content) {
		return String(content || '').split('\n').map(line => line.trim()).find(Boolean) || '';
	},
}));
