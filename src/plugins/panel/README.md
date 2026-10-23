# Control panels

A file named `*.panel.json` opens as a form, and a file named `*.status.json` opens as a read-only dashboard. A panel edits only its own file, and also reads the stored status file of the same name (`home.panel.json` reads `home.status.json` in the same folder). Neither uses the network. You sync both with the usual Pull and Push, with any provider.

The form is described by the panel file itself, and the values you set are stored in the same file. A program elsewhere reads the file to pick up the values, and can write a status file for you to look at.

Switch to ✏️ to edit the JSON directly; the form is rebuilt from it when you switch back.

```json
{
  "title": "Home PC",
  "controls": [
    { "type": "heading", "label": "Settings" },
    { "id": "heater", "type": "number", "label": "Heater target", "unit": "°C", "min": 15, "max": 28, "step": 0.5, "default": 20 },
    { "id": "porch_light", "type": "toggle", "label": "Porch light" },
    { "id": "mode", "type": "select", "label": "Mode", "options": ["home", "away", { "value": "vac", "label": "Vacation" }] }
  ],
  "values": { "heater": 21, "porch_light": true, "mode": "home" }
}
```

| Key | Meaning |
|---|---|
| `title` | Shown above the form. Defaults to the file name. |
| `controls` | The form, top to bottom. |
| `values` | `{ id: value }`, written by the form. A control without a stored value shows its `default`, which is not written until you change it. |

Any other top-level key is kept as it is when the form writes the file. The file's indentation is kept too.

## Control types

Every control except `heading` and `note` needs an `id`, which is its key in `values`, and can have a `label` (defaults to the id).

| `type` | Value | Options |
|---|---|---|
| `heading` | none | `label` |
| `note` | none | `text`: a line of help text |
| `number` | number | `min`, `max`, `step`, `integer: true`, `unit`, `default` |
| `slider` | number | as `number` |
| `toggle` | `true` / `false` | `default` |
| `select` | any JSON value | `options`: values, or `{ "value": …, "label": "…" }` |
| `text` | string | `placeholder`, `required`, `maxLength`, `pattern` (a regular expression the whole value must match), `patternHint` (the message when it doesn't) |
| `textarea` | string | as `text`, plus `rows` |
| `button` | none (a command) | see *Commands* below |
| anything else | any JSON value | edited as raw JSON, so nothing in the file is out of reach |

A value is saved when an input commits (leaving the field, Enter, picking an option). A value that fails validation is not saved; the reason is shown under the field.

## Working with a program

The usual setup is two files with one writer each. You edit the panel file in gh-memo and push it. The program reads the panel file and writes the status file of the same name. You pull that, and the form shows what it reports. Neither side ever has to merge the other's edits.

### What the form shows from the status file

The form reads the status file as stored on this device, so it shows what you last pulled (open `x.status.json` and Pull it for a newer copy; the form updates as soon as it is stored, without reopening). Nothing is shown from it until it exists locally.

- Above the controls: **Online** / **Late** / **Offline** and how long ago it was updated, as in the dashboard.
- Under each setting: **✓ Applied** when the reported value matches, **⏳ Not picked up yet** while the status `rev` is older than the panel's, **⚠️** with the program's error, **Reported: …** when it differs, or **Not handled by the program** when `accepts.values` doesn't list it.
- Under each button: its latest runs, with the state from `results` (*waiting* until the program's `rev` reaches the entry's, *no result* after that) and the output.
- Below the form: the status file's `report`.

### Commands

A **`button`** control queues a command in the panel file. `command` names the command (defaults to the button's `id`). `confirm: true`, or a question string, asks before queuing. `fields` are controls whose values become the command's `args`: they are validated, but never stored in `values`. Under each button, its latest queued entries are shown. Their results are in the status file.

```json
{
  "controls": [
    { "id": "backup", "type": "button", "label": "Run backup now", "confirm": true },
    { "id": "download", "type": "button", "label": "Download file",
      "fields": [{ "id": "url", "type": "text", "label": "URL", "required": true, "pattern": "https?://.+" }] }
  ],
  "rev": 4,
  "queue": [
    { "id": "c-20261022T073049-h1ukhb", "command": "download", "args": { "url": "https://…" }, "at": "2026-10-22T07:30:49.404Z", "rev": 4 }
  ]
}
```

| Key | Written by | Meaning |
|---|---|---|
| `rev` | gh-memo | Goes up by one with every change to `values` or `queue`, so the program can tell whether anything changed. |
| `queue` | gh-memo | Commands. Each has a unique `id`, the `command` name, `args`, the time `at`, and the `rev` it was queued with. |
| `keep_days` | you | How long queue entries are kept (default 7; at most 50 are kept). |

### Status file

```json
{
  "updated": "2026-10-22T08:10:07Z",
  "heartbeat_seconds": 60,
  "rev": 4,
  "values": { "heater": 21, "mode": "vac", "porch_light": true },
  "errors": { "heater": "thermostat not responding" },
  "accepts": { "values": ["heater", "mode", "porch_light"], "commands": ["backup", "download"] },
  "results": {
    "c-20261022T073049-h1ukhb": { "state": "failed", "at": "2026-10-22T07:30:57Z", "output": "timed out after 2 s" }
  },
  "report": {
    "Uptime": "up 4 hours, 28 minutes",
    "Disk free": "Filesystem  Size  Used Avail Use% Mounted on\n/dev/nvme0n1p6  230G  186G   42G  82% /",
    "Disk use": { "type": "meter", "value": 82, "unit": "%", "warn": 90 },
    "Last backup": { "type": "time", "value": "2026-10-22T07:22:31Z" }
  }
}
```

Every key is optional. The dashboard shows:

| Key | Shown as |
|---|---|
| `updated`, `heartbeat_seconds` | A status line: **Online** if `updated` is within two heartbeats of now (plus a minute for sync delay), **Late** within ten, else **Offline**. It's computed from the copy you have open, so pull for a newer one. |
| `rev` | "panel rev N": the panel revision the program last processed. The form uses it to tell "not picked up yet" from "picked up but different". |
| `values`, `errors` | Each value as the program reports it, with its error (`{ id: message }`) if any. |
| `accepts` | `{ values: [ids], commands: [names] }`: what the program handles. The form marks the rest. |
| `results` | `{ command id: { state, at, output } }`, newest first. `state` is typically `running`, `done`, `failed` or `rejected`. |
| `report` | `{ label: entry }`. An entry is a string (multi-line strings are shown preformatted), a number, or `{ "type": "meter" \| "time" \| "list" \| "text", … }`, as in `plugins/panel/report.js`. Everything is shown as text, never as HTML. |

Other keys are ignored, so a program can write more.

### Writing the program

One loop, run every `heartbeat_seconds`:

1. Pull, and read the panel file.
2. If `rev` is higher than the last one processed: apply each value from `values`, recording failures in `errors`. Run each `queue` entry whose `id` has no result yet, and record its result. Results must be keyed by `id`, because that is what makes a command run only once.
3. Drop results whose `id` is no longer in the queue.
4. Write the status file with `rev`, `values` as actually applied, `updated` set to now, and the rest. Then commit and push it.

The program never writes the panel file.

`examples/panel_agent.py` is a complete sample program (Python, standard library only) that does exactly this, through a git checkout or a Dropbox-synced folder. Its settings and commands are demonstrations, meant to be replaced.

## Adding a control type

Add an entry to `types` in `plugins/panel/controls.js` (the rendering) and, if it has rules, a case in `validate` in `plugins/panel/model.js`.
