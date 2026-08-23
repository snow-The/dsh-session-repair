# dsh-session-repair

Scans and repairs DSH session logs (`~/.dsh/sessions/**/session.jsonl.zstd`).

## Fixes

- **Single-frame corrupt logs** — a session file re-compressed as one zstd frame breaks
  the harness at boot (`first frame is not exactly one header line`). The plugin rebuilds
  the log in the canonical multi-frame layout: one JSON line per zstd frame.
- **Unknown event types** — events written by newer harness builds (e.g. `llm/failover`)
  make older harnesses refuse the whole log (`SessionFormatUnsupportedError`). The plugin
  marks such events `"ignorable": true` (the event is kept; the harness skips it).

## Tools

- `session_repair_scan` — read-only report of every session log: zstd frame count,
  line count, header validity, parse errors, unknown event types.
- `session_repair_fix` — repairs problem logs (or one `sessionId`). Backs up each file as
  `<file>.bak-repair-<timestamp>` before replacing it, then verifies the rebuilt layout
  (frames == lines). Restart the harness afterwards.

## Requirements

- `zstd` CLI on PATH (Debian/Ubuntu: `apt install zstd`).
- The known-type allowlist is conservative; pass `extraKnownTypes` to fix if a type is
  actually known to the running harness.

## Safety

- Never writes in place: backup → rebuild to temp → verify → atomic rename.
- Scan is strictly read-only.
