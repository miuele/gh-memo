# Local-First Web Editor

[Try Online](https://miuele.github.io/gh-memo-app)

## Core Idea
This is a lightweight, zero-backend web application for note-taking and file editing. It is designed around a local-first architecture: all files are cached and edited directly within the browser using IndexedDB. The application syncs directly to remote cloud providers (GitHub and Dropbox) via their REST APIs entirely from the client side. There is no intermediate backend or database server.

Because it operates natively in the browser, the application works offline and can be installed as a Progressive Web App (PWA).

## Quick Start
To build and run the application locally:
1. Ensure `m4` and `make` are installed on your system.
2. Run `make` to build the project.
3. Run `make serve` to start a local development server.

## Configuration & Authentication
To sync your files, you need to configure a Keychain with appropriate credentials:
- **GitHub**: Use a Fine-grained Personal Access Token (PAT). For security, it is recommended to scope the token only to the specific repositories you intend to edit, granting "Contents" read and write permissions.
- **Dropbox**: Requires a Dropbox App Key. The application uses the PKCE flow to authorize access to your Dropbox files without storing a long-lived secret key.

## Features
### Storage & Synchronization
- Offline-First: All file creation, deletion, and editing operations happen instantly against the local IndexedDB cache.

- Direct API Sync: Users can selectively push or pull files directly to a configured GitHub repository (via the Contents API) or a Dropbox folder.

- Conflict Resolution: If a file is modified locally and remotely, the application intercepts the pull request and provides a basic text diff merge to prevent data loss.

- Cross-Tab Locking: Utilizes the browser's BroadcastChannel API to detect if a file is being edited in another tab, freezing the UI to prevent local overwrite conflicts.

### Virtual File System (VFS)
- Decoupled Credentials: Authentication tokens (Keychains) are managed separately from repository configurations (Workspaces). A single GitHub token can be mapped to multiple workspace mount points securely.

- Chroot Mount Points: Workspaces can be configured to mount specific sub-directories of a repository (e.g., src/docs), abstracting the rest of the repository away from the user interface.

- Declarative Symlinks: Supports .symlink files containing JSON payloads. Clicking these files triggers the application router to instantly tear down the current environment and load a different locally configured workspace.

### Editing & Organization
- Format Support: Includes a plugin architecture for rendering different file types. It supports raw text editing, rich Markdown rendering (including KaTeX math parsing and syntax highlighting), and read-only viewing for PDFs and images.

- Local Pinning: Files and directories can be pinned to the top of the sidebar for quick access. Pins are scoped to their specific workspace.

- Deep Search: Includes a client-side search function that scans both filenames and the raw text content of all files currently cached in the active workspace.

## Security Notes
- Local Storage: Authentication tokens and file metadata are stored in the browser's `localStorage`. Note content is stored in `IndexedDB`.
- No Encryption: Local data is currently stored in plaintext within the browser's storage engines. It is recommended to use this application only on trusted, private devices.

## Technical Limitations
Because this application relies entirely on client-side API requests, it is bound by the constraints of the providers it connects to:

- GitHub File Size: The GitHub Contents API strictly limits file uploads and downloads to 10MB or less.

- Memory Constraints: Large binary files (like high-resolution images or large PDFs) are stored directly in IndexedDB and held in browser memory during viewing, which may affect performance on low-end devices.

- Rate Limiting: Heavy, recursive folder fetching on large repositories can trigger GitHub's secondary rate limits if performed too frequently.

