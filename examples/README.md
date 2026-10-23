# examples

## rs_server.py: a folder on your computer
`rs_server.py` is a minimal remoteStorage server that serves one directory. It needs Python 3.9+ and, for HTTPS on a local network, the `openssl` command. Files stay plain files, so an editor, git or `panel_agent.py` can work on the same folder.

1. From the repository root, make a token for each device: `python3 examples/rs_server.py --add-token phone`. It prints the token once; paste it into that device's keychain.
2. Start the server. By default a page from any origin may call it, but every request still needs a token. To allow only your copy of the app, add `--allow-origin https://miuele.github.io` (or for example `http://localhost:8000` for `make serve`; repeat it to allow several). The server logs why it refuses a request.
   - Same computer only: `python3 examples/rs_server.py ~/notes`, then use `http://127.0.0.1:8765/storage/`. Browsers allow an https page to call `127.0.0.1` over plain HTTP.
   - Local network: `python3 examples/rs_server.py ~/notes --bind 192.168.1.10` (or `--bind 0.0.0.0 --ip 192.168.1.10`). The server then uses HTTPS with its own private certificate authority, which `openssl` creates once in `~/.config/gh-memo-server/`. That CA is limited by name constraints to the server's IP addresses, so even if its key leaked it could not vouch for any other site. The leaf certificate is valid for a year and is renewed at startup.
   - With a certificate you already have (for example from `tailscale cert`, or Let's Encrypt for your own domain): add `--cert` and `--key`, and `--host-name` with that name.
3. On each device, trust the CA once by importing the `ca.crt` path that the server prints:
   - **Windows / macOS / Linux, Chrome**: Settings > Privacy and security > Security > Manage certificates, and import it as a trusted authority (on Windows and macOS this is the system store).
   - **Firefox (desktop)**: Settings > Privacy & Security > Certificates > View Certificates > Authorities > Import, and tick "Trust this CA to identify websites".
   - **Android**: Settings > Security > Encryption & credentials > Install a certificate > CA certificate. Chrome uses it then. Firefox for Android also needs its hidden switch: Settings > About Firefox, tap the logo five times, then Settings > Secret Settings > "Use third party CA certificates".
4. In Chrome, the first request to a local address shows a "Local network access" prompt; allow it.

`--insecure-http` allows plain HTTP on a LAN address, but Firefox blocks an https page from calling it, and Chrome only allows it after the local network prompt.

Every write names the version it replaces (`If-Match`), so a push over a newer remote version is refused and you are asked to pull first, also when the newer version came from another program editing the folder. One race is not caught: a program that writes the same file during the instant between the server's check and its write is overwritten.

## panel_agent.py

A sample program for the other side of the panel plugin, which is built in only with `make PLUGINS="image pdf markdown panel text"`; see `src/plugins/panel/README.md`.
