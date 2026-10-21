define('lib/net', [], () => {
	// Default ceiling for any single remote request (GitHub/Dropbox APIs).
	// Chosen to comfortably cover slow mobile connections without leaving
	// the UI hung indefinitely on a stalled socket.
	const NETWORK_TIMEOUT_MS = 10000;

	// A fetch() wrapper that aborts the request after `timeoutMs` and throws
	// a clearly-labeled Error instead of the raw (unhelpful) AbortError.
	// Every remote call in the app routes through this so a stalled network
	// always surfaces a bounded, user-visible failure rather than a silent hang.
	// Callers can pass their own AbortSignal via options.signal; in that case
	// we still race it against our own timeout by aborting our controller
	// whenever the caller's signal aborts.
	//
	// IMPORTANT: fetch() resolves as soon as response *headers* arrive, not
	// once the body has finished downloading. Every call site in this app
	// reads the body (res.json()/res.blob()/res.text()) separately, after
	// fetchWithTimeout has already returned. If we disarmed the timer at
	// that point, a slow body transfer (which is where nearly all of the
	// time goes on a throttled connection, since GitHub/Dropbox payloads
	// are the response body) would run completely unguarded. So instead of
	// clearing the timer here, we hand back the Response with its
	// body-reading methods wrapped: the same timeout budget, and the same
	// AbortController, stay live until the body is actually consumed (or
	// fails), and the timer is only cleared then.
	const fetchWithTimeout = async (url, options = {}, timeoutMs = NETWORK_TIMEOUT_MS) => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);

		const { signal: callerSignal, ...restOptions } = options;
		if (callerSignal) {
			if (callerSignal.aborted) controller.abort();
			else callerSignal.addEventListener('abort', () => controller.abort(), { once: true });
		}

		const timeoutError = () => new Error(`Request timed out. Check your connection and try again.`);

		let res;
		try {
			res = await fetch(url, { ...restOptions, signal: controller.signal });
		} catch (err) {
			clearTimeout(timer);
			throw err.name === 'AbortError' ? timeoutError() : err;
		}

		// Wrap the body-consuming methods so the timeout guard spans the
		// full transfer, not just the initial round trip. Non-body members
		// (res.ok, res.status, res.headers, ...) pass through untouched.
		const bodyMethods = ['json', 'text', 'blob', 'arrayBuffer', 'formData'];
		return new Proxy(res, {
			get(target, prop, receiver) {
				if (bodyMethods.includes(prop)) {
					return async (...args) => {
						try {
							return await target[prop](...args);
						} catch (err) {
							throw err.name === 'AbortError' ? timeoutError() : err;
						} finally {
							clearTimeout(timer);
						}
					};
				}
				const value = Reflect.get(target, prop, target);
				return typeof value === 'function' ? value.bind(target) : value;
			}
		});
	};

	return { NETWORK_TIMEOUT_MS, fetchWithTimeout };
});
