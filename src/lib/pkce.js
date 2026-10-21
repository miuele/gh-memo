define('lib/pkce', [], () => ({
	// Generates a cryptographically random string
	generateCodeVerifier: () => {
		const array = new Uint32Array(28);
		crypto.getRandomValues(array);
		return Array.from(array, dec => ('0' + dec.toString(16)).slice(-2)).join('');
	},

	// Hashes the verifier into a base64-url encoded challenge
	generateCodeChallenge: async (verifier) => {
		const encoder = new TextEncoder();
		const data = encoder.encode(verifier);
		const digest = await crypto.subtle.digest('SHA-256', data);
		return btoa(String.fromCharCode(...new Uint8Array(digest)))
			.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	},
}));
