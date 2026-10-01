# Contributing

Use Node.js 22 or later. No dependency installation is required. Run `npm test` and `npm run demo`.

Keep adapters separate from the provider-neutral policy. Do not edit provider transcripts, store credentials, invoke a model from deterministic hooks, block work on Cachetoast's own errors, or make cache-hit/quota guarantees. Test changes to config merging, timing, context-size gating, and hook contracts. Use synthetic transcript fixtures; never add real customer conversations.

## Release checklist

- Confirm current provider docs, hooks, and native compaction controls; update the dated behavior report.
- Test on supported Node versions and POSIX platforms. Test prompt guards through trusted hooks in each supported client before claiming end-to-end support.
- Inspect `npm pack --dry-run`: exclude state, credentials, customer transcripts, and local research scratch files.
- Select an available package name or namespace and set author/repository metadata for the actual publisher. Verify version and license.
- Review the archive locally before publishing to npm or making a GitHub repository public.
- Describe native compaction separately from deterministic handoff extraction; document any remaining unsupported behavior.
