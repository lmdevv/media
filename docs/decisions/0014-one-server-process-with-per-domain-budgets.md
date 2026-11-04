# 0014. Run one server process with per-domain worker caps and one transcode limit

- Status: Accepted, 2026-11-03
- Decisions: D29

## Context

Movies and music each run their own media service with their own ffmpeg children, scanner, and
limits. On one server, a music rescan and a movie transcode compete for the same CPU, disk, and
memory. Movies' NixOS module runs its media service under a system call filter, and both products
mount media read-only.

## Decision

- One server process runs worker pools and ffmpeg child processes.
- Each domain has its own caps, so a music rescan cannot starve a transcode.
- One server-wide transcode limit covers every domain. Guests have the lowest priority under it
  (ADR 0007).
- Media mounts stay read-only.
- The sandbox stays.

## Consequences

- The deploy runs one server process. Domains share hardware through its pools.
- Adding a domain means adding its pools and caps, not a new service.
- A transcode limit reached by household streams leaves no room for guest streams.
- The server never writes to a media mount. Temporary segments go to the server's own folder.
- `scripts/check-sandbox.sh` keeps running the server's tests under the module's system call
  filter.

## Alternatives rejected

- One media service per domain, as today. The product is one server (ADR 0002).
- A shared pool for every domain with no caps. A music rescan could starve a transcode.

## Edge cases settled

- A rescan that hits its domain's cap waits. It does not take a transcode's slot.
- A guest stream is the first to wait when the transcode limit is reached.
- Original media stays read-only to the server.
