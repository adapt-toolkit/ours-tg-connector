# tg-connector 2.0.0 (major release)

This release promotes the validated `prerelease` line to `main` as a major
release of `@ours.network/tg-connector`. The version is produced by the `main`
version-bump job from the merge commit's Conventional Commits subject; it is not
written by hand.

| package | current `latest` | expected release |
|---|---|---|
| `@ours.network/tg-connector` | 1.0.0 | 2.0.0 |

## Dependencies

- `@ours.network/sdk` 5.0.0 (exact pin; previously a 4.1.1 nightly)
- development: `@ours.network/cli` 4.0.0 and `@ours.network/daemon` 5.0.0

## Why major

The owner requires a coordinated stable major release of ours.network
components. The connector now runs on the thin SDK 5 client and expects a
separately installed shared daemon reached through a gateway client profile.

## Changes promoted from prerelease

- Integration with the published thin SDK and standalone daemon.
- An explicit private gateway control listener can be configured.
- Acknowledged external Telegram owner tokens are retired on shutdown.
- Optional Docker deployment contribution.
- CI qualifies the connector against the pinned published SDK/CLI/daemon
  artifacts; the dependency lock is tracked and CI uses Node 22.
