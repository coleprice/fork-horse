# Large files and binaries

## Current limits and behavior

Artifacts documents **32 MB per individual file or blob** and **1 GB per
repository**. These are provider limits, not promises that every operation here
can handle those sizes. See the [Artifacts limits](https://developers.cloudflare.com/artifacts/platform/limits/).
The provider's [documented Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/) does not advertise Git LFS support;
do not assume an LFS upload endpoint exists.

The server-side `submit_work` commit API accepts text file contents only (UTF-8
strings, at most 200 files within a bounded 1 MiB request). It is unsuitable for
binary uploads. Git transport can carry binaries within its own bounds, but
review reports binary changes as **binary**, without an image preview or a text
diff. Every agent fork stores its own repository copy, so checked-in assets
multiply storage and transfer work across forks; budget for those copies.

## Oversized-file quick check

The registered `.forkhorse/quick/large-files.js` check fails on a regular file
whose size is **10 MB or more**, using decimal MB: **10,000,000 bytes**. Its
failure names the file and byte size, cites the 32 MB Artifacts limit and points
here. It checks the reviewed commit using `ctx.list` and `ctx.stat`; it never
reads binary contents into the check. Stat returns the blob's size and a NUL
heuristic from only the first 8 KiB. See the [quick-check API](receipts.md#quick-checks-fh-010).

This is a review-time guard with headroom, not a pre-push hook. A file rejected
by Artifacts cannot reach review. Removing a large file from the latest commit
also does not remove its blob from Git history. The check observes the snapshot,
not total historical repository storage. Existing path, tree, call, sample-byte
and deadline budgets still apply and fail closed; a passing snapshot check is
not a guarantee that a repository fits the provider's 1 GB limit.

## Roadmap: LFS-compatible storage on R2

The following is planned work; none of it is implemented or live in this packet:

- Store large objects in R2 behind an LFS-compatible service, keeping small
  pointer files in Git.
- Use claims as LFS locks to coordinate edits to binary assets.
- Verify referenced objects and their integrity during promote before moving
  the canonical ref.
- Show image previews in review for supported assets.

This requires a separate design for authorization, object lifecycle and storage
costs. No R2 binding, LFS endpoint, locking protocol or preview service is added
by this check.
