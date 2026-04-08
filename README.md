# gh-memo

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
- **Dropbox**: Requires a Dropbox App Key. The application uses the PKCE flow to authorize access to your Dropbox files.

## Security Notes
- Local Privacy: All data (tokens, metadata, and content) is stored in **plaintext** within the browser's localStorage and IndexedDB. No local at-rest encryption is implemented, nor is it planned. **Usage is recommended only on trusted, private devices**; users must secure data at the OS or hardware level.
- External resources are loaded using Subresource Integrity (SRI), and Markdown rendering is processed via DOMPurify.

## Features
### Storage & Synchronization
- Offline-First: All file creation, deletion, and editing operations happen instantly against the local IndexedDB cache.

- Direct API Sync: Users can selectively push or pull files directly to a configured GitHub repository (via the Contents API) or a Dropbox folder.

- Conflict Resolution: If a file is modified locally and remotely, the application intercepts the pull request and provides a basic text diff merge to prevent data loss.

- Cross-Tab Locking: Utilizes the browser's BroadcastChannel API to detect if a file is being edited in another tab, freezing the UI to prevent local overwrite conflicts.

### Virtual File System (VFS)
- Decoupled Credentials: Authentication tokens (Keychains) are managed separately from repository configurations (Workspaces). A single GitHub token can be mapped to multiple workspace mount points.

- Chroot Mount Points: Workspaces can be configured to mount specific sub-directories of a repository (e.g., src/docs), abstracting the rest of the repository away.

- Workspace Forest: Workspaces sharing a remote origin are grouped into trees. This enables tree-level navigation and pin resolution across multiple mount points.

- Declarative Symlinks: Supports .symlink files containing JSON payloads. Clicking these files triggers the application router to instantly tear down the current environment and load a different locally configured workspace. Example: `{ "owner": "rust-lang", "repo": "nomicon", "rootDir": "src" }`

### Editing & Organization
- Format Support: Includes a plugin architecture for rendering different file types. It supports raw text editing, rich Markdown rendering (including KaTeX math parsing and syntax highlighting), and read-only viewing for PDFs and images.

- Pinning: Files and directories can be pinned for quick access. Pins are stored at the repository (tree) level.

- Deep Search: Includes a client-side search function that scans both filenames and the raw text content of all files currently cached in the active workspace.

## Technical Limitations
As a client-side application, behavior is bound by provider and browser constraints:

- API Limits: GitHub's Contents API limits file transfers to 10MB.
- Memory: Large binaries are held in memory during use; performance may degrade on low-end devices.
- Git Bloat: Git handles binaries poorly; frequent updates to large files will cause repository bloat.
- Rate Limiting: High-frequency recursive fetching may trigger secondary rate limits.

