// Plugins in priority order: the first whose canHandle() matches wins.
define('plugins/registry',
	['plugins/image', 'plugins/pdf', 'plugins/markdown', 'plugins/panel', 'plugins/text', 'plugins/unsupported'],
	(Image, PDF, Markdown, Panel, Text, Unsupported) => {
		const plugins = [Image, PDF, Markdown, Panel, Text, Unsupported];

		return {
			plugins,
			find: (filename) => plugins.find(p => p.canHandle(filename)),
		};
	});
