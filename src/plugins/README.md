# Plugins

A plugin renders one family of files. `plugins/registry` lists them in priority order;
the first whose `canHandle(filename)` returns true wins, and `unsupported` is the catch-all.

A plugin module returns `{ canHandle(filename), create() }`. `create()` returns an instance:

| Member | Required | Meaning |
|---|---|---|
| `supportedModes` | yes | Any of `'edit'`, `'view'`. With both, the 👁️/✏️ toggle is shown. |
| `preferredMode` | no | `'view'` or `'edit'`: the mode this plugin's files open in. Without it, a file opens in whichever mode the previous one used. |
| `mount(filename, content, viewLayer, editLayer, onEdit, { isViewMode, host })` | yes | Render into the layers. Call `onEdit(newText)` on every change. May be async. `host` is described below. |
| `unmount()` | no | Release resources (object URLs, listeners). |
| `onModeSwitch(isViewMode)` | no | Called after the user toggles between view and edit. |
| `freeze()` | no | Make the editor read-only (the file was edited in another tab). |
| `textarea` | no | The live edit buffer, if any; export reads it in preference to the stored content. |

## Other files: the host

A plugin instance edits one file, the one it is mounted on. It never uses the network (fetch, XMLHttpRequest and the like) and never imports `storage/`, `remote/` or `actions/`; `tests/host.test.mjs` checks this. To read other files it uses `host` (from `actions/host`):

| Member | Meaning |
|---|---|
| `host.read(path)` | `Promise<{ content, isDirty } \| null>`: the stored copy (text as a string, binary as a Blob), or `null` if it isn't stored locally. Read-only; nothing is fetched. |
| `host.onChange(cb)` | `cb({ paths })` when a file read through this host changes in the local store (autosave, pull, another tab). Coalesced to one call per 250 ms. Returns an unsubscribe function. |

Paths are relative to the open file, or start at the repository root with `/`, and percent-encoding is decoded (`my%20pic.png` is `my pic.png`). They resolve in the repository (forest tree: same repo and branch) of the workspace that was active when the file was opened, and may cross mount points: `../shared/logo.png` is the same file whether or not `shared/` is its own workspace, and the deepest workspace holding the path is read. A URL, a path above the repository root or a path through a `.symlink` throws. The host records the paths read (`reads()`, for the app), and is disposed when the plugin is unmounted: `read` then gives `null` and callbacks stop.

There is no allowlist: any file of the repository can be read. A boundary could be added in the host later (for example for third-party plugins), since every read goes through it.

Plugins with their own helper modules keep them in a folder of the same name, e.g. `plugins/panel/` (see its README).
