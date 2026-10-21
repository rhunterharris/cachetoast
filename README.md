# Cachetoast

Cachetoast tries to compact **large, idle** Claude Code and Pi sessions before their prompt cache expires. If compaction cannot run, it holds your next prompt once and offers a handoff to a fresh session. Codex uses that handoff fallback.

Zero dependencies. No separate API keys or telemetry. Timers and handoffs run locally; native compaction uses your agent's model and normal billing. Node.js 22+, macOS/Linux.

Built by [R. Hunter Harris](https://huntersoftwareconsulting.com) at [Hunter Software Consulting](https://huntersoftwareconsulting.com), fractional product and technology leadership for B2B SaaS.

Watch my podcast, [Build & Break Through](https://www.youtube.com/@BuildandBreakThroughPodcast), and subscribe to my newsletter, [Don't SaaS Me](https://hunter-software-consulting.beehiiv.com/).

## Install

From the repo you want to protect:

```sh
npx cachetoast init
```

It installs for the agents you have (`--provider codex` to choose, `--dry-run` to preview). The runtime is copied into `.cachetoast/runtime`, so hooks never call npm or the network. Run `update` instead of `init` to refresh an existing install; it keeps your providers, policy, state, and handoffs.

Then restart your agent.

- **Claude Code:** start from the repo root and trust the project. The repo-local `cachetoast-idle` plugin provides the timer; mods require terminal v2.1.287+ or desktop v2.1.286+. Check `/plugin` for loading errors. Older clients retain the handoff fallback.
- **Codex:** trust the project, run `codex` in the repo, and approve the hooks in `/hooks`. The Codex app skips unapproved hooks and can't approve them ([openai/codex#47283](https://github.com/openai/codex/issues/47283)).
- **Pi:** trust the project.

## How it works

For sessions of at least 100k tokens (`--min-context-tokens`), Claude Code and Pi schedule one native compaction attempt per idle period:

| Cache TTL | Compact after idle | Time before expiry |
| --- | --- | --- |
| 5 minutes | 4 minutes | 1 minute |
| 30 minutes | 25 minutes | 5 minutes |
| 1 hour | 55 minutes | 5 minutes |

New activity cancels the timer. Successful compaction avoids the handoff for that idle period and does not start another timer. If the agent closes or the computer sleeps past expiry, Cachetoast skips the cold compaction. Resuming while still warm can restore the remaining timer.

Claude Code 2.1.299+ has its own [idle compaction](https://code.claude.com/docs/en/settings-reference#idlecompaction): terminal sessions on the 1h TTL, about 54 minutes idle, 200k tokens by default. Cachetoast lowers that minimum to match its own (`CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS`, 100k at least), so Claude usually compacts first and Cachetoast's timer covers what it skips: the 5m TTL, the desktop app and other clients, older versions, and `idleCompaction: false`. Either compaction prevents the hold.

If compaction failed, was skipped, or is unavailable, your next prompt after the deadline is held once:

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
- **Codex:** 30m (GPT-5.6 and later). OpenAI's API now also offers `12h`, but Codex CLI 0.163 doesn't request it. A Codex lead has said signed-in Codex users keep their cache indefinitely; OpenAI hasn't documented this, so Cachetoast still assumes 30m. If you trust it, raise the TTL with `--codex-cache-ttl 12h` or `24h`.
- **Pi:** 5m for Claude models (1h with `PI_CACHE_RETENTION=long`), otherwise 30m.
- **Anything else:** 30m.

To override, run `init --pi-cache-ttl 1h` (or `--codex-cache-ttl`, `--claude-cache-ttl`; `5m`, `30m`, `1h`, `12h`, `24h`). That saves to `~/.config/cachetoast/config.json`; `.cachetoast/local.json` takes the same format per repo. A TTL reported by a Claude session always wins.

## Commands

```sh
node .cachetoast/runtime/bin/cachetoast.mjs status              # sessions, sizes, TTLs, policy
node .cachetoast/runtime/bin/cachetoast.mjs handoff --key KEY   # print a saved handoff (or --provider claude for the latest)
node .cachetoast/runtime/bin/cachetoast.mjs uninstall           # restore original files
```

## What to commit

Commit `.cachetoast/runtime`, `.cachetoast/config.json`, and the agent settings, hooks, handoff command or skill, and `.claude/skills/cachetoast-idle` plugin. These use repo-relative paths and need no launchd, cron, or global service. `local.json`, `state/`, `handoffs/`, and `manifest.json` are gitignored; handoffs contain conversation excerpts.

`init` and `update` are idempotent and leave unrelated settings alone. `uninstall` restores the original files and removes local state. Each stops if you've edited the managed files by hand.

## Limits

- Savings come mostly from Claude Code quota: its large contexts are rewritten to cache at 2× the input price after a miss. Codex and Pi misses cost less.
- Mobile and remote clients may not show the notice clearly, and can't start a fresh local session to run the handoff. Send the prompt again to continue, or run the handoff later from the CLI or desktop app.
- Expiry is estimated from a local clock; Cachetoast can't see the provider's cache.
- Timers require the agent to remain running and awake. Starting a compaction before expiry does not guarantee completion or a cache hit. A failed attempt keeps the handoff available.
- Codex exposes compaction to an owning app-server connection, but its repo hooks cannot portably reach an arbitrary open session. Codex gets the native context ceiling and handoff guard, without a proactive timer.
- No hold if hooks are disabled, untrusted, or time out.
- Claude plugin statically validated with Claude Code 2.1.292; adapter behavior tested with synthetic sessions. Claude's native idle compaction is read from its transcript summary; no live run confirmed it. No paid live-compaction experiment was run. Other integration baselines: Codex CLI 0.163.0 and Pi 0.85.1. Research: [docs/research.md](docs/research.md).

## Develop

```sh
npm test && npm run demo
```

## License

[MIT](LICENSE) © 2026 R. Hunter Harris, Hunter Software Consulting. Inspired in part by [Antiburn](https://github.com/antiburn/antiburn); no Antiburn code is included.
