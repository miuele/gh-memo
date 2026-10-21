define('lib/encoding', [], () => {
	// UTF-8 safe base64 encode/decode for text content.
	const utoa = (text) => btoa(Array.from(new TextEncoder().encode(text)).map(b => String.fromCharCode(b)).join(''));
	const atou = (b64) => new TextDecoder().decode(new Uint8Array(atob(b64.replace(/[\r\n]+/g, '')).split('').map(c => c.charCodeAt(0))));

	// Converts a Blob to a base64 string using chunked reads to stay within
	// call-stack limits for large files (avoids a single massive fromCharCode call).
	const blobToBase64 = async (blob) => {
		const buffer = await new Response(blob).arrayBuffer();
		const bytes = new Uint8Array(buffer);
		let binary = '';
		const chunkSize = 8192;
		for (let i = 0; i < bytes.length; i += chunkSize) {
			binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
		}
		return btoa(binary);
	};

	return { utoa, atou, blobToBase64 };
});
