// Dropbox OAuth (PKCE): send the user to Dropbox, then exchange the code
// for tokens when Dropbox redirects back to the app.
define('remote/dropboxAuth', ['model/config', 'lib/net', 'lib/pkce'], (Config, Net, Pkce) => ({
	async link(kcId) {
		const keychain = Config.keychains[kcId];
		const key = keychain.appKey;

		if (!key) return alert("Please enter your App Key first (and ensure it is saved).");

		const verifier = Pkce.generateCodeVerifier();
		const challenge = await Pkce.generateCodeChallenge(verifier);

		sessionStorage.setItem('dbx_pkce_verifier', verifier);
		sessionStorage.setItem('dbx_pkce_keychain_id', kcId);

		const redirectUri = window.location.origin + window.location.pathname;
		const authUrl = `https://www.dropbox.com/oauth2/authorize?client_id=${key}&response_type=code&code_challenge=${challenge}&code_challenge_method=S256&token_access_type=offline&redirect_uri=${encodeURIComponent(redirectUri)}`;
		window.location.href = authUrl;
	},

	// Returns true if this page load was a successful redirect back from Dropbox.
	async handleRedirect() {
		const params = new URLSearchParams(window.location.search);
		const code = params.get('code');
		const verifier = sessionStorage.getItem('dbx_pkce_verifier');
		const kcId = sessionStorage.getItem('dbx_pkce_keychain_id');

		if (!code || !verifier || !kcId) return false;

		window.history.replaceState({}, document.title, window.location.pathname);
		sessionStorage.removeItem('dbx_pkce_verifier');
		sessionStorage.removeItem('dbx_pkce_keychain_id');

		const keychain = Config.keychains[kcId];
		if (!keychain) return false;

		try {
			const redirectUri = window.location.origin + window.location.pathname;
			const res = await Net.fetchWithTimeout('https://api.dropboxapi.com/oauth2/token', {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					client_id: keychain.appKey,
					grant_type: 'authorization_code',
					code: code,
					code_verifier: verifier,
					redirect_uri: redirectUri
				})
			});

			const data = await res.json();

			if (!res.ok) {
				console.error("DROPBOX API ERROR:", data);
				throw new Error(data.error_description || data.error || "Unknown Auth Failure");
			}

			keychain.provider = 'dropbox';
			keychain.token = data.access_token;
			keychain.refreshToken = data.refresh_token;

			Config.saveKeychains();

			return true;
		} catch (err) {
			alert(`PKCE Linking failed: ${err.message}`);
			return false;
		}
	},
}));
