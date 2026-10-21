m4_changequote([[, ]])m4_dnl
m4_include([[resources.m4]])m4_dnl
// Generated from resources.m4 by `make`. Do not edit build/resources.js directly.
// Every external library the app loads on demand, with its SRI hash.
define('resources', [], () => ({
	jsdiff: { url: 'URL_JSDIFF_JS', sri: 'SRI_JSDIFF_JS' },
	marked: { url: 'URL_MARKED_JS', sri: 'SRI_MARKED_JS' },
	dompurify: { url: 'URL_DOMPURIFY_JS', sri: 'SRI_DOMPURIFY_JS' },
	katexCss: { url: 'URL_KATEX_CSS', sri: 'SRI_KATEX_CSS' },
	katexJs: { url: 'URL_KATEX_JS', sri: 'SRI_KATEX_JS' },
	markedKatex: { url: 'URL_MARKED_KATEX_EXTENSION_JS', sri: 'SRI_MARKED_KATEX_EXTENSION_JS' },
	highlightJs: { url: 'URL_HIGHLIGHT_JS', sri: 'SRI_HIGHLIGHT_JS' },
	highlightCss: { url: 'URL_HIGHLIGHT_GITHUB_CSS', sri: 'SRI_HIGHLIGHT_GITHUB_CSS' },
}));
