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

<!-- Template 2: Tree Group Header -->
<template id="tree-group-template">
    <div class="tree-group" style="border: 1px solid var(--border); border-radius: 6px; margin-bottom: 25px; overflow: hidden; background: #fafafa;">
        <div class="tree-header" style="background: #eef4f9; padding: 15px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 10px;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <h3 class="tree-title" style="margin: 0; font-size: 16px; color: var(--accent);"></h3>
                <button class="btn-add-mount" style="background: var(--accent); color: white; border: none; font-size: 12px;">+ Add Mount Point</button>
            </div>
            
            <!-- Shared Origin Configuration -->
            <div style="display: flex; gap: 10px; flex-wrap: wrap; align-items: center; font-size: 12px;">
                <select class="tree-keychain" style="padding: 4px;"></select>
                <div class="tree-gh-only" style="display: flex; gap: 6px; align-items: center;">
                    <input type="text" class="tree-owner" placeholder="Owner" style="width: 100px; padding: 4px;"> /
                    <input type="text" class="tree-repo" placeholder="Repo" style="width: 120px; padding: 4px;">
                    <input type="text" class="tree-branch" placeholder="Branch" style="width: 80px; padding: 4px;">
                    <input type="text" class="tree-host" placeholder="Host" style="width: 150px; padding: 4px;">
                </div>
            </div>
        </div>
        <div class="mount-list" style="padding: 15px; display: flex; flex-direction: column; gap: 10px;"></div>
    </div>
</template>

<!-- Template 3: Mount Point Row (Simplified Workspace) -->
<template id="mount-row-template">
    <div class="mount-row" style="display: flex; align-items: center; justify-content: space-between; padding: 10px; background: white; border: 1px solid var(--border); border-radius: 4px;">
        <div style="display: flex; align-items: center; gap: 15px; flex-grow: 1;">
            <input type="text" class="ws-name" placeholder="Name" style="width: 150px; padding: 6px; font-size: 13px;">
            <input type="text" class="ws-rootDir" placeholder="/" style="flex-grow: 1; padding: 6px; font-size: 13px; font-family: monospace;">
            
            <label style="display: flex; align-items: center; gap: 5px; font-size: 12px; cursor: pointer;">
                <input type="checkbox" class="ws-shallow"> Shallow
            </label>
        </div>
        
        <div style="display: flex; gap: 8px; margin-left: 20px;">
            <span class="leaf-warning" style="display: none; color: #c98200; font-size: 16px; cursor: help;" title="Cannot be deep (shallow: false) because child sub-directories are mounted below this path.">⚠️</span>
            <button class="btn-switch" style="font-size: 12px;">Switch</button>
            <button class="btn-clear" style="font-size: 12px; color: #c98200;" title="Clear DB">🧹</button>
            <button class="btn-delete" style="font-size: 12px; color: var(--danger);" title="Delete">🗑️</button>
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
