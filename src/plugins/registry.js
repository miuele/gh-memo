// Plugins in priority order: the first whose canHandle() matches wins.
define('plugins/registry',
	['plugins/image', 'plugins/pdf', 'plugins/markdown', 'plugins/text', 'plugins/unsupported'],
	(Image, PDF, Markdown, Text, Unsupported) => {
		const plugins = [Image, PDF, Markdown, Text, Unsupported];

		return {
			plugins,
			find: (filename) => plugins.find(p => p.canHandle(filename)),
		};
	});
