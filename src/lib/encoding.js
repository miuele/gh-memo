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

	// Git's blob id for these bytes: SHA-1 of "blob <size>\0" + bytes, which is
	// the sha GitHub lists and expects. Null where crypto.subtle is missing
	// (plain http from another host).
	const gitBlobSha = async (blob) => {
		const subtle = globalThis.crypto && globalThis.crypto.subtle;
		if (!subtle) return null;
		const bytes = new Uint8Array(await new Response(blob).arrayBuffer());
		const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
		const data = new Uint8Array(header.length + bytes.length);
		data.set(header);
		data.set(bytes, header.length);
		const digest = new Uint8Array(await subtle.digest('SHA-1', data));
		return Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
	};

	return { utoa, atou, blobToBase64, gitBlobSha };
});
