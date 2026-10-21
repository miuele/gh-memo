// Offline support: registers sw.js and, when a newer build has been
// installed, offers to reload into it. The new worker waits (see sw.js.m4)
// until the user accepts, so a page never runs under another build's cache.
define('app/serviceWorker', ['ui/status', 'actions/files'], (Status, Files) => {
	let reloadRequested = false;

	const reload = async () => {
		reloadRequested = true;
		await Files.flushPendingEdit();
		location.reload();
	};

	const offerUpdate = (worker) => Status.offer('New version available', 'Reload', async () => {
		reloadRequested = true;
		await Files.flushPendingEdit();
		// The reload happens on controllerchange, once the new worker is active.
		worker.postMessage('skipWaiting');
	});

	const register = async () => {
		const container = navigator.serviceWorker;
		// Without a controller the page runs from the network (first install),
		// so there is no older build to replace yet.
		let controlled = !!container.controller;

		container.addEventListener('controllerchange', () => {
			if (!controlled) return void (controlled = true);
			// Another tab accepted the update, so this page now runs on the new
			// worker but still with the old code.
			if (reloadRequested) location.reload();
			else Status.offer('New version installed', 'Reload', reload);
		});

		let registration;
		try {
			registration = await container.register('sw.js');
		} catch (err) {
			return console.error('Service Worker failed', err);
		}

		if (registration.waiting && container.controller) offerUpdate(registration.waiting);
		registration.addEventListener('updatefound', () => {
			const worker = registration.installing;
			worker.addEventListener('statechange', () => {
				if (worker.state === 'installed' && container.controller) offerUpdate(worker);
			});
		});
	};

	return {
		install() {
			// Service workers need http(s); from file:// the app runs without one.
			if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
			window.addEventListener('load', register);
		},
	};
});
