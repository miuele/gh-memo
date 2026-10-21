# Plugins

A plugin renders one family of files. `plugins/registry` lists them in priority order;
the first whose `canHandle(filename)` returns true wins, and `unsupported` is the catch-all.

A plugin module returns `{ canHandle(filename), create() }`. `create()` returns an instance:

| Member | Required | Meaning |
|---|---|---|
| `supportedModes` | yes | Any of `'edit'`, `'view'`. With both, the 👁️/✏️ toggle is shown. |
| `mount(filename, content, viewLayer, editLayer, onEdit, { isViewMode })` | yes | Render into the layers. Call `onEdit(newText)` on every change. May be async. |
| `unmount()` | no | Release resources (object URLs, listeners). |
| `onModeSwitch(isViewMode)` | no | Called after the user toggles between view and edit. |
| `freeze()` | no | Make the editor read-only (the file was edited in another tab). |
| `textarea` | no | The live edit buffer, if any; export reads it in preference to the stored content. |
