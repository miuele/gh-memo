// Cross-tab messaging over BroadcastChannel. Other tabs of the app on the
// same origin receive every message; the sender does not.
define('lib/tabChannel', [], () => {
	const CHANNEL_NAME = 'github_notes_sync';
	let channel = null;
	const get = () => channel || (channel = new BroadcastChannel(CHANNEL_NAME));

	return {
		// Message types
		SIDEBAR_REFRESH: 'SIDEBAR_REFRESH',
		LOCAL_EDIT: 'LOCAL_EDIT',

		post(message) { get().postMessage(message); },
		onMessage(handler) { get().onmessage = (event) => handler(event.data); },
	};
});
