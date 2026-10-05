# Cachetoast

When you come back to a **large, idle** coding-agent session whose prompt cache has likely expired, Cachetoast holds your first prompt before the agent re-reads the whole context at full price, and gives you a handoff to continue in a fresh session instead. Works with Claude Code, Codex, and Pi.

Zero dependencies. No LLM calls, API keys, telemetry, or network access. Node.js 22+, macOS/Linux.

Built by [R. Hunter Harris](https://huntersoftwareconsulting.com) at [Hunter Software Consulting](https://huntersoftwareconsulting.com), fractional product and technology leadership for B2B SaaS.

## Install

From the repo you want to protect:

```sh
npx github:rhunterharris/cachetoast init
```

It installs for the agents you have (`--provider codex` to choose, `--dry-run` to preview). The runtime is copied into `.cachetoast/runtime`, so hooks never call npm or the network. Run `update` instead of `init` to refresh an existing install; it keeps your providers, policy, state, and handoffs.

Then restart your agent.

- **Codex:** trust the project, run `codex` in the repo, and approve the hooks in `/hooks`. The Codex app skips unapproved hooks and can't approve them ([openai/codex#47283](https://github.com/openai/codex/issues/47283)).
- **Pi:** trust the project.

## How it works

If a session is at least 100k tokens (`--min-context-tokens`) and has been idle past its cache deadline, your next prompt is held once:

```text
Cachetoast held this prompt!

This ~180k-token session has been idle 55 min with a 1h cache TTL, so its prompt cache has likely expired and continuing would re-read it all as uncached input.
Send it again to continue here OR start a new session (not resume or fork) and run:
 /cachetoast-handoff claude-0123456789abcdef01234567
(The handoff includes your prompt.)
```

Send the prompt again to continue anyway. Or start a **fresh** session in the same repo and run the command from the notice: `/cachetoast-handoff KEY` in Claude Code, `$cachetoast-handoff KEY` in Codex. In Pi, `/handoff` opens the fresh session for you. The handoff is a local extract (requests, latest reply, compaction summary, Git status), not a model summary, and the new session is titled `CT - <subject>`.

Small sessions are left alone, since a fresh session wouldn't be cheaper. Cachetoast also:

- **Caps compaction at 250k tokens** (`--target-tokens`, 100k–250k), keeping any lower limit already set.
- **Shows cache status in Pi's footer** (`cache warm 24m · 180k`, then `cache cold`).
- **Fails open:** if it errors, you see a warning and your prompt goes through.

## Cache TTL

The hold starts at the TTL minus up to 5 minutes (1h → 55 min, 30m → 25 min, 5m → 4 min).

- **Claude Code:** read from the session (1h on Pro/Max; 5m on API keys, cloud providers, or usage credits).
- **Codex:** 30m (GPT-5.6 and later).
- **Pi:** 5m for Claude models (1h with `PI_CACHE_RETENTION=long`), otherwise 30m.
- **Anything else:** 30m.

To override, run `init --pi-cache-ttl 1h` (or `--codex-cache-ttl`, `--claude-cache-ttl`; `5m`, `30m`, `1h`, `24h`). That saves to `~/.config/cachetoast/config.json`; `.cachetoast/local.json` takes the same format per repo. A TTL reported by a Claude session always wins.

## Commands

```sh
node .cachetoast/runtime/bin/cachetoast.mjs status              # sessions, sizes, TTLs, policy
node .cachetoast/runtime/bin/cachetoast.mjs handoff --key KEY   # print a saved handoff (or --provider claude for the latest)
node .cachetoast/runtime/bin/cachetoast.mjs uninstall           # restore original files
```

## What to commit

Commit `.cachetoast/runtime`, `.cachetoast/config.json`, and the agent settings, hooks, and handoff command or skill. `local.json`, `state/`, `handoffs/`, and `manifest.json` are gitignored; handoffs contain conversation excerpts.

`init` and `update` are idempotent and leave unrelated settings alone. `uninstall` restores the original files and removes local state. Each stops if you've edited the managed files by hand.

## Limits

- Savings come mostly from Claude Code quota: its large contexts are rewritten to cache at 2× the input price after a miss. On one heavy Max user's transcripts, that was ~2–3% of the weekly allowance. Codex and Pi misses cost less.
- Mobile and remote clients may not show the notice clearly, and can't start a fresh local session to run the handoff. Send the prompt again to continue, or run the handoff later from the CLI or desktop app.
- Expiry is estimated from a local clock; Cachetoast can't see the provider's cache.
- No hold if hooks are disabled, untrusted, or time out.
- Verified with Claude Code 2.1.285, Codex CLI 0.159.2, and Pi 0.85.1; provider formats can change. Research: [docs/research.md](docs/research.md).

## Develop

```sh
npm test && npm run demo
```

## License

[MIT](LICENSE) © 2026 R. Hunter Harris, Hunter Software Consulting. Inspired in part by [Antiburn](https://github.com/antiburn/antiburn); no Antiburn code is included.
