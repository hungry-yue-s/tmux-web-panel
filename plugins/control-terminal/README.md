# Native windows and internal pane streams

This plugin provides `ctx.controlTerminals` with two independent providers.
The workbench uses `nativePool` / `/ws/native-window/:windowId`: a persistent
ordinary tmux client in the project's POSIX/MSYS PTY adapter. It preserves tmux
bindings, borders, status, copy-mode and overlays. `nativeWindow` reports
`{ available, protocol: 1, reason? }` in Node info; the dedicated capability API
also reports `mode: 'native-window'`. See the [native workbench design](../../docs/local-workbench-design.md)
for its complete protocol, ownership, build and upgrade rules.

The remainder of this document describes the separate internal pane-stream
protocol. Its `controlTerminal` capability is
`{ available, protocol: 1, snapshotVersion, reason? }` and requires a tmux build
reporting `#{pane_snapshot_version}=1`. Pane streams use control clients, not
ordinary attach clients, and do not emulate all native tmux UI semantics.
Neither provider replaces the legacy `ctx.terminals` or Mosh lifecycle.

All endpoints are local Node endpoints. Remote access uses the existing
`/n/:serverId` relay and its authentication/TLS policy.

## HTTP

Responses use the normal `Api` envelope; values below describe `data`.

- `GET /api/workbench/capability`: the capability above.
- `GET /api/workbench/panes`: `{ instanceId, complete, panes }`, each pane has
  `{ instanceId, sessionId, windowId, paneId, cols, rows, resizeAllowed }`.
  The list describes structure; the socket's `ready` determines the current
  resize permission, including other clients and the visibility lease.
- `POST /api/workbench/panes`: body
  `{ instanceId, sessionId, requestId, cols, rows, cwd? }` creates one detached
  single-pane window in an existing session. Returns status 201 and
  `{ instanceId, sessionId, requestId, windowId, paneId, cols, rows, resizeAllowed }`.
  No existing window is split or selected. Receipt files under
  `configDir/workbench-requests` make a request id permanent: an uncertain
  outcome is never retried, including after a Node restart. Reusing an id with
  different parameters is rejected. Refresh the workspace to inspect an
  uncertain result; do not automatically send a new id.
- `GET /api/workbench/panes/:paneId/history?instanceId=…&sessionId=…&windowId=…&before=…&limit=500`: read-only plain-text history. Returns `{ instanceId, sessionId, windowId, paneId, lines, total, before, nextBefore }`, oldest line first. `before` is an exclusive index into the currently retained history; omitted means its newest end. `nextBefore` is the prior page end or null. A page has at most 500 lines and excludes the visible screen. Retained tmux history can scroll while the program runs; the indices are not permanent absolute line ids. Render it in a separate reader, never reset/write the live xterm.
- `DELETE /api/workbench/panes/:paneId?instanceId=…&sessionId=…&windowId=…` is
  explicit remote process termination and returns 204. The identity check and
  `kill-pane` execute on the same tmux server. Closing a local tile or socket
  only unsubscribes and must not call DELETE.

## WebSocket

`/ws/pane-stream/:paneId?instanceId=…&sessionId=…&windowId=…&cols=…&rows=…&protocol=1`

Encode id path/query components. All four identity fields are required and
verified against one server-instance snapshot. `cols`/`rows` in the URL do not
resize an existing pane during attach; the real grid comes in `ready`.

Client frames:

- `{ type: 'input', data: string }` (at most 64 KiB UTF-8): one delivery only;
  never replay uncertain input after a disconnect. The last visible subscriber
  owns input and resizing. Bytes become fixed `send-keys -H` arguments, never
  arbitrary control commands. Front ends must not forward terminal-emulator
  automatic query replies: tmux already answers the remote program's queries.
- `{ type: 'input', encoding: 'base64', data }` preserves raw X10 mouse bytes from `xterm.onBinary`; strict base64 and the same 64 KiB decoded limit apply.
- `{ type: 'resize', cols, rows }`: bounded integer dimensions, only accepted
  for a single-pane window owned by this subscriber, with no foreign tmux client
  on the session. Existing multi-pane geometry is preserved. Windows linked across sessions are rejected with UNSUPPORTED and use the compatible terminal view.
- `{ type: 'visibility', visible: boolean }`: hiding pauses delivery only;
  becoming visible takes the lease and requests a new snapshot. Sending true
  again transfers the lease without a reconnect.

Server frames:

- `ready`: `{ type, protocol: 1, instanceId, sessionId, windowId, paneId,
  cols, rows, resizeAllowed }`. May repeat when ownership changes. A repeated
  ready updates metadata; it does not clear the terminal.
- `snapshot`: `{ type, seq, encoding: 'base64', data, cols, rows, historyLines?, historyTotal? }`. Decode
  bytes, set the remote grid, reset the terminal and write the complete native
  VT snapshot. Do not treat it as plain text. It contains normal/alternate
  screens, cursor and parser/input modes, and pending escape/UTF-8 bytes.
- `output`: `{ type, seq, encoding: 'base64', data }`. Decode to `Uint8Array`
  and write in order. Byte encoding preserves UTF-8 split across control chunks.
- `error`: `{ type, code, message, retryable }`; `exit`: `{ type, reason }`.

Each subscription starts with snapshot `seq: 0`; output and subsequent snapshots
increase its sequence. Wait for both ready and snapshot before enabling input.
Each new connection gets a snapshot; there is no resume sequence or byte-ring
replay. Subsequent snapshots can also occur after resize, visibility changes or
another view joining the same pane. A connection generation must ignore frames
from an old socket.

The connection bootstrap validates server lifetime/session through the actual control pipe, and every native snapshot must match the requested instance/window/pane.

The control pool key includes the selected tmux socket, server lifetime and
session. The native `capture-pane -Q -p` command cuts queued raw output, captures
state, and resets the pane offset in one non-yielding tmux callback. Its guarded
result is delivered synchronously before parsing the next `%output`; all current
views receive that snapshot boundary. An unsupported snapshot fails closed.

Subscriber queues, input, control responses, outstanding commands and session
counts are bounded. A slow socket is closed and must resnapshot on reconnect.
Pipe clients use a local socketpair and the existing tmux file IPC, including on MSYS where SCM_RIGHTS is absent. Both IPC directions cap the peer queue at 512 messages (each bounded by MAX_IMSGSIZE); client stdout and server input also have byte limits. Relay stdio is nonblocking. Disposal marks the workbench mutation service closed before detaching control clients; an in-flight creation records its confirmed/uncertain outcome and never starts a further mutation after disposal.

Disposal detaches control clients only, retaining every tmux session and pane.
Mosh continues using its existing screen transport and ordinary terminal path;
it is not used as a pipe for this protocol.

## Native integration checks

Set `TWP_CONTROL_TEST_TMUX` to the built native tmux executable and run
`vitest run test/lib/control-integration.test.js`. Tests use only explicitly
named private sockets, remove inherited `TMUX`/`TMUX_PANE`, and verify the
recorded PID/socket identity before cleanup. They do not inspect or alter the
user's default tmux server.
