#!/usr/bin/env python3
"""A sample program for a gh-memo control panel.

It reads a panel file (written by gh-memo), applies the values, runs the
queued commands, and writes the status file of the same name
(pc.panel.json -> pc.status.json), which gh-memo shows beside the panel's
controls and opens on its own as a dashboard. The format is described in src/plugins/panel/README.md.

The two files travel through whatever gh-memo syncs with:

  * a git checkout of the GitHub repository (default): the agent pulls before
    reading and commits + pushes the status file after writing it;
  * a folder synced by the Dropbox client, or served by rs_server.py for the
    remoteStorage provider (--no-git): the agent just reads and writes the
    files.

Usage:

  python3 panel_agent.py --dir ~/notes --panel pc.panel.json
  python3 panel_agent.py --dir ~/Dropbox/notes --no-git --once

Only the Python standard library is used. The settings and commands below are
demonstrations: replace the bodies of the functions in SETTINGS and COMMANDS
with what your machine should actually do.
"""

import argparse
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request

# ---------------------------------------------------------------------------
# What this program can do. Edit these.
# ---------------------------------------------------------------------------

STATE_FILE = os.path.expanduser('~/.panel_agent_state.json')  # where the demo keeps "applied" settings
DOWNLOAD_DIR = os.path.expanduser('~/Downloads/panel')


def load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(state):
    with open(STATE_FILE, 'w') as f:
        json.dump(state, f, indent=2)


def set_heater(value, state):
    # A real program would talk to the thermostat here and raise on failure.
    if not 15 <= value <= 28:
        raise ValueError('out of range')
    state['heater'] = value


def set_porch_light(value, state):
    state['porch_light'] = bool(value)


def set_mode(value, state):
    if value not in ('home', 'away', 'vac'):
        raise ValueError(f'unknown mode {value!r}')
    state['mode'] = value


# Settings: value id -> function(value, state). Raising an exception reports
# the message under that setting in gh-memo; the old value stays reported.
SETTINGS = {
    'heater': set_heater,
    'porch_light': set_porch_light,
    'mode': set_mode,
}


def run_backup(args, state):
    # A real program would start the backup here. Return value = output shown in gh-memo.
    time.sleep(1)
    state['last_backup'] = now_iso()
    return 'backup finished'


def run_download(args, state):
    url = str(args.get('url', ''))
    if not url.startswith(('http://', 'https://')):
        raise ValueError('only http(s) URLs are allowed')
    os.makedirs(DOWNLOAD_DIR, exist_ok=True)
    target = os.path.join(DOWNLOAD_DIR, os.path.basename(url.split('?')[0]) or 'download')
    with urllib.request.urlopen(url, timeout=30) as res, open(target, 'wb') as out:
        shutil.copyfileobj(res, out)
    return f'saved to {target}'


# Commands: command name -> function(args, state) -> output text. Raising an
# exception marks the command "failed" with the message as its output.
COMMANDS = {
    'backup': run_backup,
    'download': run_download,
}


def build_report(state):
    """The "report" section: { label: string | {type: ...} }."""
    report = {}
    usage = shutil.disk_usage(os.path.expanduser('~'))
    used = round(100 * usage.used / usage.total)
    report['Disk use'] = {'type': 'meter', 'value': used, 'unit': '%', 'warn': 90}
    report['Disk free'] = f'{usage.free / 1e9:.0f} GB of {usage.total / 1e9:.0f} GB'
    try:
        with open('/proc/uptime') as f:
            seconds = float(f.read().split()[0])
        report['Uptime'] = f'up {int(seconds // 3600)} h {int(seconds % 3600 // 60)} min'
    except OSError:
        pass
    if state.get('last_backup'):
        report['Last backup'] = {'type': 'time', 'value': state['last_backup']}
    return report


# ---------------------------------------------------------------------------
# The protocol. Usually no need to edit below.
# ---------------------------------------------------------------------------

def now_iso():
    return dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def read_json(path, default):
    try:
        with open(path, encoding='utf-8') as f:
            doc = json.load(f)
        return doc if isinstance(doc, dict) else default
    except (OSError, ValueError):
        return default


def write_json(path, doc):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write('\n')
    os.replace(tmp, path)


def process(panel, status, state):
    """One pass: apply values and run new commands. Returns the new status
    (without `updated`) and whether anything changed."""
    rev = panel.get('rev') if isinstance(panel.get('rev'), int) else 0
    seen = status.get('rev', -1)
    errors = dict(status.get('errors') or {})
    results = dict(status.get('results') or {})
    queue = [e for e in panel.get('queue') or [] if isinstance(e, dict) and isinstance(e.get('id'), str)]

    if rev != seen:
        for key, value in (panel.get('values') or {}).items():
            setter = SETTINGS.get(key)
            if not setter or state.get(key) == value:
                errors.pop(key, None)
                continue
            try:
                setter(value, state)
                errors.pop(key, None)
            except Exception as err:  # report, don't crash
                errors[key] = str(err)

    # A command runs once: its result, keyed by id, is the record that it ran.
    for entry in queue:
        if entry['id'] in results:
            continue
        handler = COMMANDS.get(entry.get('command'))
        if not handler:
            results[entry['id']] = {'state': 'rejected', 'at': now_iso(), 'output': f"unknown command {entry.get('command')!r}"}
            continue
        try:
            output = handler(entry.get('args') or {}, state)
            results[entry['id']] = {'state': 'done', 'at': now_iso(), 'output': output or ''}
        except Exception as err:
            results[entry['id']] = {'state': 'failed', 'at': now_iso(), 'output': str(err)}

    # Forget results of commands gh-memo has dropped from the queue.
    ids = {e['id'] for e in queue}
    results = {k: v for k, v in results.items() if k in ids}

    new = {
        'rev': rev,
        'values': {k: state[k] for k in SETTINGS if k in state},
        'errors': errors,
        'accepts': {'values': sorted(SETTINGS), 'commands': sorted(COMMANDS)},
        'results': results,
        'report': build_report(state),
    }
    old = {k: status.get(k) for k in new}
    return new, json.dumps(new, sort_keys=True) != json.dumps(old, sort_keys=True)


def git(repo, *args, check=True):
    return subprocess.run(['git', '-C', repo, *args], check=check, capture_output=True, text=True)


def pull(repo):
    res = git(repo, 'pull', '--rebase', '--autostash', '--quiet', check=False)
    if res.returncode:
        print(f'git pull failed: {res.stderr.strip()}', file=sys.stderr)


def push_status(repo, status_path, message):
    git(repo, 'add', status_path)
    if not git(repo, 'diff', '--cached', '--quiet', check=False).returncode:
        return
    git(repo, 'commit', '--quiet', '-m', message, '--', status_path)
    # gh-memo may have pushed the panel meanwhile; it never touches the
    # status file, so a rebase always applies cleanly.
    for _ in range(3):
        if not git(repo, 'push', '--quiet', check=False).returncode:
            return
        pull(repo)
    print('git push failed; will retry next round', file=sys.stderr)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--dir', default='.', help='the git checkout or synced folder holding the files')
    ap.add_argument('--panel', default='pc.panel.json', help='panel file, relative to --dir')
    ap.add_argument('--status', help='status file, relative to --dir (default: the panel\'s name with '
                                     '.status.json, which is the one gh-memo shows in the panel)')
    ap.add_argument('--poll', type=float, default=15, help='seconds between reads of the panel')
    ap.add_argument('--heartbeat', type=int, default=300,
                    help='write the status at least this often (seconds), even when nothing changed; '
                         'each write is a commit when using git')
    ap.add_argument('--no-git', action='store_true', help='just read and write files (e.g. a Dropbox folder)')
    ap.add_argument('--once', action='store_true', help='do one round and exit')
    opts = ap.parse_args()

    repo = os.path.abspath(opts.dir)
    panel_path = os.path.join(repo, opts.panel)
    if not opts.status:
        opts.status = re.sub(r'\.panel\.json$', '', opts.panel, flags=re.I) + '.status.json'
    status_path = os.path.join(repo, opts.status)
    state = load_state()
    last_write = 0.0

    while True:
        if not opts.no_git:
            pull(repo)
        panel = read_json(panel_path, {})
        status = read_json(status_path, {})
        new, changed = process(panel, status, state)
        save_state(state)

        if changed or time.time() - last_write >= opts.heartbeat:
            write_json(status_path, {'updated': now_iso(), 'heartbeat_seconds': opts.heartbeat, **new})
            last_write = time.time()
            if not opts.no_git:
                push_status(repo, opts.status, f"status: rev {new['rev']}" + (' (heartbeat)' if not changed else ''))
            print(f"{now_iso()} wrote status, rev {new['rev']}{'' if changed else ' (heartbeat)'}")

        if opts.once:
            break
        time.sleep(opts.poll)


if __name__ == '__main__':
    main()
