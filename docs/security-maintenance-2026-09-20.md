# Production dependency maintenance — 2026-09-20

Separate from Site PR #45. Baseline: master d8552a0468a5970ee530195726f6c96e04b286b3.
No vulnerability baseline is relaxed and no production workload is executed.

The current npm production audit reports seven affected package nodes: Next,
PostCSS, sharp, Nodemailer, deepmerge-ts, @prisma/config and Prisma. This includes
new advisories against the unchanged master lockfile; #45 did not introduce them.

## Minimal dependency changes

- Next 15.5.21 → 15.5.25, within OpenNext 1.20.2's declared supported range.
- Nodemailer 9.0.3 → 9.1.1; preserve current SMTP behavior and configuration.
- Next-scoped overrides: PostCSS 8.5.23 and sharp 0.35.4. Next's own patch release
  still declares old PostCSS; upgrading Next alone does not remove all findings.
- Only @prisma/config@6.19.3: deepmerge-ts 8.0.2. Keep Prisma client, CLI, adapter,
  generators and schema at 6.19.3; do not accept the audit's suggested downgrade.

Prisma 6.19.3's configuration loader imports the `deepmerge` named export. The v8
package preserves CommonJS/ESM exports and fixes recursive-object exhaustion.
Its changes to Map values, deepmergeInto and type names are not used in this
configuration path. This remains a narrowly scoped cross-major override that
must be reconsidered on a Prisma upgrade. Client generation and builds are gates.

## Sources

- [Next advisory](https://github.com/advisories/GHSA-p293-qw3h-jr36)
- [Next image optimization advisory](https://github.com/advisories/GHSA-2xp9-vwfh-vxw4)
- [Nodemailer 9.1.1](https://github.com/nodemailer/nodemailer/releases/tag/v9.1.1)
- [Deepmerge recursion advisory](https://github.com/advisories/GHSA-ggr8-5vv4-36mx)
- [Prisma config source](https://github.com/prisma/prisma/blob/6.19.3/packages/config/src/loadConfigFromFile.ts)
- [Deepmerge v8 changes](https://github.com/RebeccaStevens/deepmerge-ts/releases/tag/v8.0.0)

## Verification

Locked dependency installation and the unchanged production audit checker pass;
the candidate reports zero production vulnerabilities. The independent reviewer
checked official package metadata and compared the actual deepmerge package
implementations using verified registry tarballs. Full tests, typecheck, Prisma
generation and Linux OpenNext/Worker CI results are recorded on this PR.

No real notification, database migration, daily/profile job or deployment is part
of this maintenance change. Disposable fixture/CI database checks do not access
production data. Keep this PR separate from #45 and do not silently merge it.
