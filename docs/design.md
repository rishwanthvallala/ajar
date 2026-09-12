# Ajar: a simple guide to the whole system

This document explains what the project does, how its parts fit together, and what happens when somebody uses it. It assumes no knowledge of Rust, WebAssembly, or collaborative editors.

It describes the implementation reviewed on 12 September 2026, at commit `0b21300`. Some intended behavior still has bugs. Those are called out here, with the detailed evidence in the [project review](D:/ajar/ajar/docs/review-2026-09-12.md).

## 1. What are we building?

The repository contains two products.

**Ajar lets somebody use part of your real computer through a browser.** You run a program on your computer, choose a project folder, and share a link. Other people can open terminals, see files, and edit together. Commands run on your computer.

**Pad gives people a shared folder and a place to run Python in their own browsers.** Nobody needs to lend a computer. Each browser runs its own programs, while a server keeps the shared files.

Both products use the same server program, called the **relay**. Its job differs between the two products.

| Question | Ajar | Pad |
|---|---|---|
| Where do commands run? | On the host's real computer. | Inside each visitor's browser. |
| Where are files saved? | In the host's project folder. | On the server. Each browser also has a working copy. |
| Does someone install a program? | The host runs the Ajar agent. Guests use a browser. | Visitors use a browser. |
| Do people share one running shell? | They can see and use the same host terminal. | Each browser has its own shell. |
| Can it use the host's installed tools? | Yes, subject to sandbox restrictions. | It has a limited set of tools prepared for the browser. |
| Are shared file contents encrypted from the server? | Content messages and optional snapshots are encrypted. | No. The server stores readable file contents. |

For example, use Ajar to investigate a bug that only happens on your colleague's machine. Use Pad to paste a Python script, process a small CSV, and share the resulting files.

## 2. A few words used in this document

| Word | Meaning here |
|---|---|
| Host | The person lending their computer in Ajar. |
| Guest | A person opening the host's share link. |
| Agent | The Ajar program running on the host's computer. |
| Relay | The server between participants. It forwards live messages and also stores Pad folders. |
| Session | A group of connected participants using the same session ID. |
| Peer | A Pad participant. Peers are equals; there is no host computer in charge. |
| Workspace | The project folder being shared. |
| Terminal | The screen where someone types commands and reads output. |
| Shell | The program that interprets those commands, such as Bash. |
| Runtime | The environment that actually executes a program. |
| WebSocket | A connection that stays open so both sides can send messages immediately. |
| Snapshot | A saved copy of files at a particular point in time. |
| Persistent storage | Data saved to disk so it can survive a server process restart. |

## 3. The main parts

### Ajar: one real machine at the center

```text
Guest browser A ----\
                    Relay server <----> Host agent <----> Project files
Guest browser B ----/                       |
                                           +----------> Shells and programs
```

The agent connects outward to the relay. The host does not need to open an incoming network port for guests.

A guest sends a request to the relay, which forwards it to the agent. The agent performs the work and sends responses back. In a hosted session, guest requests go to the host; guests do not directly send application messages to one another.

### Pad: each browser does its own computation

```text
Browser A                             Browser B
  Editor                                Editor
  Local files                           Local files
  Local shell                           Local shell
      |                                     |
      +-------- Relay: live messages -------+
      |                                     |
      +-------- Server: saved files --------+
```

The relay's live-message service and saved-file service run in the same server program. They have different responsibilities:

- Live messages tell other browsers about typing and changes.
- Saved files let someone return later, even after everyone has closed their tabs.

If Browser A runs a Python script, Browser B does not run that script automatically. Browser B receives the shared file changes after they are published.

## 4. How Ajar works, step by step

### Starting a share

1. The host runs `ajar` in a project folder, or passes a folder path.
2. The agent checks the folder. It refuses obvious dangerous choices, such as the entire home directory or filesystem root.
3. It builds a file list, leaving out generated files and ignored paths.
4. It prepares the sandbox and process limits, attempts a Git checkpoint, and scans for possible credentials.
5. It generates a session ID and an encryption key, then starts connecting to the relay.
6. It displays a link and keeps running as a control panel, or prints plain output when redirected.

The link identifies the session and carries the content key after `#k=`. That final part is called the URL fragment. Browsers do not include it in ordinary HTTP requests to the server.

There is a known startup gap: the plain-output link can be printed before the relay is ready to accept guests.

### Joining

1. A guest opens the link and enters a display name.
2. The browser opens a WebSocket to the relay and requests the session.
3. The relay assigns the guest a participant number and tells the host somebody joined.
4. The host sends the current file tree, information about existing terminals, and recent terminal output.
5. The guest introduces their name through an encrypted message. The host distributes the participant list.

The session ID selects the room. The content key lets the browser decrypt its content. These are separate jobs; knowing a session ID is not the same as knowing its key.

### Running a command

Suppose a guest types `python main.py`:

```text
Keystrokes in browser
    -> encrypted message
    -> relay
    -> host agent
    -> shell on host computer
    -> Python runs
    -> output returns through agent and relay
    -> browsers display the output
```

The host uses a **PTY**, or pseudo-terminal. This is an operating-system connection that makes a shell behave as though it is attached to a real terminal. The browser uses **xterm.js** to display the text, colors, and cursor movements it receives.

Each host terminal keeps about 256 KB of recent output in memory. A reconnecting browser can receive that output again. This is recent scrollback, not an unlimited recording of the session.

### Editing a file together

The browser editor is **Monaco**, the editor technology also used by VS Code. Monaco provides the editing interface; it does not handle collaboration on its own.

Collaboration uses **Yjs** in the browser and **Yrs**, a compatible Rust implementation, in the agent. They maintain a **CRDT**: a document representation that can merge edits arriving from different participants.

Think of it as exchanging identified editing operations, rather than repeatedly replacing the whole file with whichever person's copy arrived last.

The intended flow is:

1. A guest opens a text file.
2. The agent creates a live collaborative document if that file does not already have one.
3. The browser receives the document state and connects it to Monaco.
4. Typing changes the document and sends updates through the host to other guests.
5. After editing pauses for roughly 400 milliseconds, the agent schedules a write to disk.

Only files opened for editing get collaborative documents. The whole repository does not become one giant live document.

### Changes made outside the editor

A command can also change a file—for example, a formatter can rewrite `main.py`.

The agent watches the filesystem for changes. It compares new disk text with the live document and applies the difference. It tries to change only the affected text, so other people's cursors do not unnecessarily jump around.

The watcher also updates the file tree. It batches changes for about 250 milliseconds. If more than 500 paths change in one batch, it asks for a fresh tree instead of sending hundreds of individual changes.

Disk writes, live document updates, and watcher events must agree. Several review findings concern cases where they currently do not.

### Host controls

| Control | Intended meaning |
|---|---|
| Kick | Remove a particular guest. |
| Lock | Refuse new guests while keeping current guests connected. |
| Read-only terminals | Drop guest terminal input while allowing them to watch output. |
| Stop keeping a copy | Disable the optional relay snapshot. |
| Close | End the session and stop sharing. |

Read-only terminals are not a general “nobody can edit files” permission. The control applies to terminal input. There is also a known revocation defect in kick that needs repair.

## 5. How Pad works, step by step

### Opening a folder

1. The page gets a name from its URL. A visit to `/` generates a name and changes the address bar.
2. It asks the server for the files under that name.
3. If no files exist, it shows a starter Python script. Merely generating a name does not reserve or save it.
4. It joins the live peer session for that name.
5. It creates editor models for the text files and displays a terminal prompt.

Heavy runtime components load when needed. A person opening a link to read text should not have to wait for the entire Python runtime.

### Running Python in the browser

Pad uses **WebAssembly**, a format browsers can execute, and **Wasmer/WASIX**, which provide an environment for programs that expect files, processes, and a shell.

The browser receives prepared versions of Python, Bash, common file commands, grep, sed, and find. A small Python implementation supplies a subset of awk. The Run button currently recognizes Python files.

```text
Editor text
    -> browser's local filesystem
    -> Python runs inside the browser
    -> terminal shows output
    -> changed files are sent to the server
```

These are browser-local files, not a direct view of the visitor's ordinary personal files. The server stores the results; it does not execute the user's Python.

The shell stays around between commands, so its working directory and variables can persist. If the shell must restart, that shell state is lost.

### Saving and sharing changes

There are two paths:

**Typing:** the browser broadcasts Yjs updates for live editing and schedules a saved-file update after a pause of about 500 milliseconds.

**Commands:** when a command finishes, the browser compares its local files against what it believes the server holds. It uploads changed files and deletions. It normally skips generated files such as Python bytecode.

After the server accepts a save, the browser sends a small “files changed” message to its peers. The peers fetch the saved files from the server.

The message is a notification, not another saved copy of the folder. The server assigns a sequence number to each accepted write so changes have a server-defined order.

### Why Pad synchronization is difficult

One open file can have four representations:

| Representation | Purpose |
|---|---|
| Collaborative document | Merges live editing operations. |
| Monaco model | Holds the text displayed by the editor. |
| Browser runtime file | The bytes Python or the shell reads and changes. |
| Server file | The copy that survives after the browser closes. |

The design needs all four to agree at the right times. A CRDT helps merge typing, but it does not automatically synchronize the shell's files or make HTTP saves happen in the right order.

For example, if someone edits a CSV remotely, another browser must update its runtime before running a script against that CSV. Otherwise it processes old data and may upload that old data over the new saved version. This is one of the defects found in the review.

### First document state

A new browser asks other peers for the live state of an open document. If none answers, it starts from the saved text.

It cannot simply insert the saved text as a new local edit in every browser. Collaboration could interpret those as separate insertions and duplicate the text. Initial state exchange, including deliberately empty files, needs careful handling.

## 6. What is stored, and what survives?

| Data | Where it lives | Lifetime |
|---|---|---|
| Ajar project files | Host disk | Ordinary files, independent of the relay. |
| Ajar live documents | Agent and participating browsers | While those live document instances exist. |
| Ajar shells and recent output | Host process/memory | Tied to the running agent/terminals. A relay outage does not itself stop them. |
| Ajar session membership | Relay memory | Lost on relay restart; abandoned hosted sessions are reaped. |
| Optional Ajar snapshot | Relay memory, encrypted | Ends with the session; lost on relay restart. |
| Pad saved files | Server disk, readable JSON | Survive process restart; expire after seven days without a write. |
| Pad runtime and shell | Individual browser | Lost when that browser environment is closed or discarded. |
| Pad tombstone | Server disk | Remembers an expired name so it cannot be reused. |

An **Ajar snapshot** is an optional copy for short host outages. After the workspace has been quiet for around five seconds, the agent can offer a sealed copy to the relay. Guests can read it while the host is away. They cannot edit that snapshot.

It is not a full backup: it excludes unsupported files, can be behind current work, and disappears with the session.

**Pad storage** has a different purpose. There is no host disk to recover from, so the server saves each Pad as a JSON file. A write updates the saved text and sequence numbers. Individual files use whole-file last-write-wins storage; the durable store does not contain the complete live Yjs history.

The server writes a temporary JSON file and renames it into place. This avoids exposing a partially written JSON document during normal replacement, although stronger crash-durability and recovery work is still needed.

## 7. Messages between components

The project uses ordinary HTTP for short requests and WebSockets for live communication.

| Address | Purpose |
|---|---|
| `/ws` | Live session connection. |
| `/api/pad/{name}` with GET | Read a Pad's saved files. |
| `/api/pad/{name}` with PUT | Save Pad file changes or deletions. |
| `/healthz` | A simple server health response. |
| `/install.sh` | Installer script. |
| `/run.sh` | Script that finds or installs the agent and starts sharing. |
| `/j/{session}` | Browser page for joining an Ajar session. |

A WebSocket message has a small header and a payload:

```text
[channel: 1 byte] [stream: 4 bytes] [target: 4 bytes] [payload: remaining bytes]
```

- **Channel** says which feature the message belongs to.
- **Stream** identifies a terminal or document. Zero usually means a feature-level JSON message.
- **Target** identifies a destination or sender, depending on the routing direction.
- **Payload** contains the actual request, update, or terminal bytes.

The channels are Control, PTY, Filesystem, Presence, Document, and Store. Presence means information such as who is here and which terminal they are watching.

The relay needs routing metadata and understands control/store envelopes. It is not literally unaware of every payload. For hosted content channels, it forwards encrypted payloads without needing their plaintext.

This protocol is shared by convention across Rust, TypeScript, and test code. Changes must keep those implementations compatible.

## 8. Safety and access

There are three separate questions:

1. **Who may send a request?** Session roles, locks, and guest removal govern access.
2. **Who may read the content?** Ajar content encryption and its shared link key govern readability.
3. **What may a command do?** The host operating system's sandbox and limits govern execution.

One mechanism does not replace the others. Encrypting a command does not make the command safe.

The host sandbox uses Landlock on Linux and Seatbelt on macOS. Its intended policy allows work in the shared project and necessary temporary/cache locations, while restricting other filesystem access. It preserves access to the host's toolchain.

The defaults allow up to 12 terminals and request a 512-process limit. CPU, memory, and disk usage are not capped. Network access is normally allowed.

The agent also tries to make a Git checkpoint and warn about credentials. A checkpoint is not a complete backup of every file. A credential scan is a warning system, not proof that a folder contains no secrets.

Pad intentionally stores plaintext and has no account or lock system in the current version. Someone who can find its name can request its files and submit changes. Browser computation and server file permissions are separate concerns.

**Current security work remains necessary:** the review found message-direction ambiguity in encryption, insufficient guest revocation/control validation, and Linux confinement gaps. The policy described above should be read as the intended boundary, not a guarantee that the current implementation enforces every part of it.

## 9. Limits and failures

Limits keep small collaborative sessions from creating unbounded work.

| Limit or timeout | Current value or behavior |
|---|---|
| Initial Ajar tree | Warn/refuse above 20,000 entries unless forced. |
| Ajar file content | Reads are capped at 1 MB; initial editing refuses oversized or detected-binary files. |
| Hosted snapshot | Up to 25 MB and 5,000 files. |
| Pad saved folder | Up to 25 MB of stored content and 500 files. |
| Relay outgoing queue | About 8 MB of queued data or 2,048 frames; one large frame may be admitted into an empty queue. |
| Relay WebSocket input | Up to 32 MB per message/frame. |
| Hosted session grace | About 45 seconds after the host connection disappears. |
| Pad expiry | Seven days since its last write, with periodic cleanup. |

The Pad HTTP endpoint currently has a smaller effective request-body limit than its folder limit. This mismatch is a bug, not a second intended product limit.

| Event | Intended response | Current caution |
|---|---|---|
| Guest loses connection | Reconnect and restore the view. | Open document recovery is incomplete. |
| Host loses connection | Keep local processes running, show away state, offer snapshot reads. | Snapshots can be stale. |
| Host returns during grace | Resume the same session. | All live state still needs correct reconciliation. |
| Relay restarts | Host reconnects; Pad saved files remain on disk. | Hosted membership/snapshots are lost; policy restoration has gaps. |
| Participant falls far behind | Close the connection instead of silently dropping pieces of terminal output. | Not every queue in the system is bounded. |
| Save fails | Keep edits visibly unsaved and allow recovery/retry. | Some paths currently mark data saved too early or lose retry state. |
| Host closes deliberately | Flush pending documents and end the session. | Error exits do not all follow this orderly path. |

## 10. How it is deployed

The checked-in deployment config uses two public names:

- `ajar.rishwanth.dev` for the machine-sharing client.
- `code.rishwanth.dev` for Pad.

These are configuration values; this document does not verify the current live deployment.

**Caddy** accepts HTTPS connections, serves browser assets, and forwards relevant requests to the relay. **systemd** starts and supervises the relay on the server.

Pad needs browser security headers that enable shared memory for its runtime. A separate browser origin lets Pad use those headers without applying the same setup to the Ajar client.

The Wasmer SDK is copied with its original file layout because its workers expect neighboring files at particular paths. A **service worker**, a small browser-managed request handler, redirects known runtime package downloads to copies served by this project. Those package copies can be compressed and cached.

Deployment builds the Rust relay and both clients, transfers the outputs, updates the service and Caddy configuration, and checks server health. A separate release workflow packages the host agent for Linux and macOS.

Docker is also an intended relay distribution path. Its current build inputs and writable storage setup need the repairs identified in the review.

## 11. Where to look in the code

| Start here | What it explains |
|---|---|
| [Agent main](D:/ajar/ajar/crates/ajar/src/main.rs) | Startup, main event loop, host controls, and incoming request handling. |
| [Agent connection](D:/ajar/ajar/crates/ajar/src/client.rs) | Relay connection, encryption at the socket boundary, and reconnect attempts. |
| [Terminals](D:/ajar/ajar/crates/ajar/src/pty.rs) | Shell creation, input/output, and recent-output buffers. |
| [Documents](D:/ajar/ajar/crates/ajar/src/docs.rs) | Live documents, disk reconciliation, and pending writes. |
| [Workspace](D:/ajar/ajar/crates/ajar/src/workspace/mod.rs) | Scanning, reading files, and updating the tree. |
| [Sandbox](D:/ajar/ajar/crates/ajar/src/sandbox.rs) | Operating-system restrictions on host commands. |
| [Protocol](D:/ajar/ajar/crates/ajar-proto/src/lib.rs) | Message types, header format, and content-channel encryption boundary. |
| [Relay routing](D:/ajar/ajar/crates/ajar-relay/src/ws.rs) | Joining and forwarding messages. |
| [Session registry](D:/ajar/ajar/crates/ajar-relay/src/session.rs) | Participants, locks, snapshots, and session lifetime. |
| [Pad storage](D:/ajar/ajar/crates/ajar-relay/src/pad.rs) | Saved folders, limits, sequences, and expiry. |
| [Ajar browser](D:/ajar/ajar/web/src/main.ts) | Guest interface and how incoming messages change it. |
| [Pad app](D:/ajar/ajar/pad/src/app.ts) | Editor, store, peer connection, runtime, and Run wired together. |
| [Pad runtime](D:/ajar/ajar/pad/src/runtime.ts) | Browser-local files and program execution. |
| [Pad shell](D:/ajar/ajar/pad/src/shell.ts) | Long-lived shell and command completion detection. |
| [Pad sync](D:/ajar/ajar/pad/src/sync.ts) | Comparing runtime files with the last known saved state. |
| [Checks](D:/ajar/ajar/scripts/check.sh) | Existing agent/web verification gate. |
| [Deployment](D:/ajar/ajar/deploy/deploy.sh) | Building and transferring the server and clients. |

Rust code is grouped into **crates**, which are Rust packages. The browser applications use TypeScript, and **Vite** builds their source into files a browser can load.

For a first reading, follow a single action: open a terminal in the browser, find its outgoing message, follow relay routing, and then find the agent handler. After that, follow file editing and saving.

## 12. What needs to stay true as the project grows?

The design depends on these rules:

1. A host command runs only with valid session authority and the intended execution restrictions.
2. Encrypted data is accepted only for its correct sender, direction, and purpose.
3. Reconnecting restores both the connection and the state needed to use it.
4. A successful save means the intended version was actually persisted.
5. A stale browser or runtime copy must not silently replace newer work.
6. Deleting a file removes it consistently from every relevant representation.
7. Resource limits apply across the whole path, not just one queue or one folder.
8. Warnings and documentation describe the restrictions actually enforced.

Current testing includes Rust unit tests, TypeScript checks, agent/relay smoke tests, sandbox checks, and dedicated Pad browser suites. The main CI workflow currently omits the Pad suites, and some existing checks can pass without proving their intended behavior.

The next design work should focus on enforcing the rules above: repair security boundaries, make reconnect and save ordering explicit, keep Pad's document/model/runtime/server copies consistent, and test failures with realistic delays and interruptions. The detailed [review](D:/ajar/ajar/docs/review-2026-09-12.md) provides the implementation-specific repair list.

Features such as Pad accounts and locks, long-term encrypted hosted storage, and previewing a web server started on the host remain separate future work. They should be designed after the existing editing, execution, and saving paths behave reliably.
