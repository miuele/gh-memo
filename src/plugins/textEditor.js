// The plain <textarea> editor shared by the text-based plugins.
define('plugins/textEditor', [], () => ({
	create(content, saveCallback) {
		const textarea = document.createElement('textarea');
		textarea.style.cssText = 'display: block; width: 100%; height: 100%; box-sizing: border-box; padding: 20px; border: none; resize: none; outline: none; font-family: monospace; font-size: 15px; line-height: 1.5;';
		textarea.value = typeof content === 'string' ? content : '';

		// Auto-save hook
		textarea.addEventListener('input', (e) => saveCallback(e.target.value));

		// Standard Tab key indentation
		textarea.addEventListener('keydown', function(e) {
			if (e.key === 'Tab') {
				e.preventDefault();
				document.execCommand('insertText', false, '    ');
				saveCallback(this.value);
			}
		});

		return textarea;
	},
}));
