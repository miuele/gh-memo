m4_changequote([[, ]])
m4_changecom(<!--, -->)

m4_define([[LOAD_CSS]],
	/* $1.css starts here */
	[[m4_include([[$1.css]])]]
	/* ends here */
	)

m4_define([[LOAD_CORE]],
	<!-- $1.js starts here -->
	[[m4_include([[core/$1.js]])]]
	<!-- ends here -->
	)

m4_define([[PLUGIN]],
	<!-- $1.js starts here -->
	[[m4_include([[plugins/$1.js]])]]
	<!-- ends here -->
	)

[[<!--]] generated from m4___file__ [[-->]]

<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="UTF-8">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">

		<!-- PWA Metadata -->
		<link rel="manifest" href="manifest.json">
		<meta name="theme-color" content="#0066cc">
		<meta name="mobile-web-app-capable" content="yes">
		<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
		<meta name="apple-mobile-web-app-title" content="Notes">
		<link rel="apple-touch-icon" href="icon.png">

		<link rel="icon" type="image/x-icon" href="favicon.ico">

		<script>
			if ('serviceWorker' in navigator) {
				window.addEventListener('load', () => {
					navigator.serviceWorker.register('sw.js')
						.catch(err => console.error('Service Worker failed', err));
				});
			}
		</script>

		<title>Local-First Notes</title>

		<style>
			LOAD_CSS([[styles]])
		</style>
	</head>
	<body>

		<div id="sidebar">
			<div class="sidebar-header">
				<div id="workspace-indicator" style="width: 100%; font-size: 11px; font-weight: bold; color: var(--accent); margin-bottom: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: help;"></div>

				<button onclick="Actions.createFile()">+ New</button>
				<button onclick="DOM.fileInput.click()">📤 Upload</button>
				<button onclick="Actions.refreshTree()">🔄 Refresh List</button>
				<button onclick="Actions.openSettings()">⚙️ Setup</button>
    			<button onclick="Actions.addPin()">📌 Pin</button>
				<input type="file" id="file-upload" style="display:none;" onchange="Actions.handleFileUpload(event)">
    			<div id="pin-container" style="display: flex; flex-wrap: wrap; gap: 5px; width: 100%; margin-top: 5px;"></div>
				<input type="search" id="search-bar" placeholder="Filter files... (Enter for deep search)">
			</div>
			<ul id="file-list"></ul>
		</div>

		<div id="toggle-sidebar" onclick="UI.toggleSidebar()" title="Toggle Sidebar"></div>

		<div id="main">
			<div id="editor-header">
				<span id="current-filename">No file selected</span>
				<div style="display: flex; gap: 10px;">
					<button id="pull-btn" onclick="Actions.pullFile()" style="display:none;">⬇️ Pull File</button>
					<button id="push-btn" onclick="Actions.pushFile()" style="display:none;">⬆️ Push File</button>
					<button id="delete-btn" onclick="Actions.deleteFile()" style="display:none; color: var(--danger);">Delete</button>
				</div>
			</div>
<div id="editor-container">
				<div id="view-layer" style="width: 100%; height: 100%; overflow-y: auto; display: none; box-sizing: border-box; padding: 20px;"></div>
				<div id="edit-layer" style="width: 100%; height: 100%; overflow-y: auto; display: none; box-sizing: border-box; padding: 0;"></div>
				<div id="settings-panel"></div>
				<button id="view-toggle" onclick="Actions.toggleViewMode()" title="Toggle View/Edit">👁️</button>
			</div>
			<div id="status-bar"></div>
		</div>

<!-- Template 1: Keychain (Credentials only) -->
<template id="keychain-card-template">
    <div class="profile-card">
        <h3 class="kc-title" style="margin-top: 0;"></h3>
        <div class="form-grid">
            <div class="form-group">
                <label>Provider</label>
                <select class="kc-provider">
                    <option value="github">GitHub</option>
                    <option value="dropbox">Dropbox</option>
                </select>
            </div>
            <!-- GitHub Auth -->
            <div class="form-group gh-only">
                <label>Personal Access Token</label>
                <input type="password" class="kc-token" placeholder="ghp_...">
            </div>
            <!-- Dropbox Auth -->
            <div class="form-group dbx-only" style="display:none; grid-column: 1 / -1;">
                <label>App Key</label>
                <div style="display: flex; gap: 10px; width: 100%;">
                    <input type="text" class="kc-appkey" style="flex-grow: 1;">
                    <button class="btn-link-dbx" style="white-space: nowrap;">🔗 Link to Dropbox</button>
                </div>
                <div class="dbx-status" style="margin-top: 5px; font-size: 0.9em; font-weight: bold;"></div>
            </div>
        </div>
        <button class="btn-delete" style="color: var(--danger); margin-top: 10px;">🗑️ Delete Keychain</button>
    </div>
</template>

<!-- Template 2: Workspace (Mount Point only) -->
<template id="workspace-card-template">
    <div class="profile-card">
        <div style="display: flex; justify-content: space-between; margin-bottom: 15px;">
            <h3 class="ws-title" style="margin: 0;"></h3>
            <div style="display: flex; gap: 8px;">
                <button class="btn-switch">Switch</button>
                <button class="btn-clear" style="color: #c98200;">🧹 Clear DB</button>
                <button class="btn-delete" style="color: var(--danger);">🗑️ Delete</button>
            </div>
        </div>
        <div class="form-grid">
            <div class="form-group" style="grid-column: 1 / -1;">
                <label>Linked Keychain</label>
                <select class="ws-keychain"></select> 
            </div>
            
            <!-- Git Specific Fields -->
            <div class="form-group ws-gh-only"><label>Host</label><input type="text" class="ws-host"></div>
            <div class="form-group ws-gh-only"><label>Owner</label><input type="text" class="ws-owner"></div>
            <div class="form-group ws-gh-only"><label>Repository</label><input type="text" class="ws-repo"></div>
            <div class="form-group ws-gh-only"><label>Branch</label><input type="text" class="ws-branch"></div>
            
            <!-- Universal VFS Fields -->
            <div class="form-group"><label>Root Directory (Optional)</label><input type="text" class="ws-rootDir" placeholder="e.g. docs/src"></div>
            <div class="form-group" style="flex-direction: row; align-items: center; gap: 10px;">
                <input type="checkbox" class="ws-shallow" style="width: auto;">
                <label style="margin: 0;">Shallow Fetch (Show Folders)</label>
            </div>
        </div>
    </div>
</template>

		<script>

			LOAD_CORE([[Core]])
			LOAD_CORE([[Utils]])
			LOAD_CORE([[DBService]])

			const Plugins = {
				PLUGIN([[Builtins]])
			};

			const PluginRegistry = Object.values(Plugins);

			LOAD_CORE([[UI]])
			LOAD_CORE([[Actions]])

			LOAD_CORE([[Boot]])

		</script>
	</body>
</html>
