# Cachetoast

Catches the first prompt you send to a **large, idle** coding-agent session whose prompt cache has probably expired, before it re-reads the whole context, and gives you a prompt to continue in a fresh session instead. Works with Claude Code, Codex, and Pi.

Built by [R. Hunter Harris](https://huntersoftwareconsulting.com) at [Hunter Software Consulting](https://huntersoftwareconsulting.com).

Zero dependencies. No LLM calls, API keys, telemetry, or network access. Node.js 22+, macOS/Linux.

## Why

After an idle gap longer than the provider's cache lifetime, your next message re-sends the whole context at full input price. On a 200k-token session that is expensive. A fresh session with a short handoff is often cheaper. On a small session it usually isn't, so small sessions are left alone.

## Install

From the repo you want to protect:

```sh
npx cachetoast init
```

It installs for the agents you have (Claude Code, Codex, Pi) and asks nothing. Add `--dry-run` to preview, or `--provider codex` to pick agents. The runtime is copied into `.cachetoast/runtime`, so hooks never call npm or the network.

Restart your agent. Codex: trust the project and review hooks in `/hooks`. Pi: trust the project.

To update an existing installation to the latest release:

```sh
npx cachetoast@latest update
```

Add `--dry-run` to preview, or `--repo /path/to/repo` to target another repo. Updates keep installed providers, policy, session state, and saved handoffs, and copy the runtime of the version you ran into the repo. `init` adds providers; `update` refreshes existing ones.

## What it does

- **Holds the first cold prompt, once.** If the session is ≥ 100k tokens (`--min-context-tokens`) and idle past your cache deadline, your next prompt is held with a notice and a saved handoff. Send it again to continue anyway; nothing else is held until the next idle period. Agents can't show anything before you type, so this is the last moment the cost can be avoided.
- **Shows cache status in Pi's footer** (`cache warm 24m · 180k`, then `cache cold · 180k · /handoff`).
- **Caps compaction at 250k tokens** (`--target-tokens`, 100k–250k). Earlier limits in the repo are kept. Claude Code applies it to running sessions too, so a session already over the cap compacts on its next prompt.
- **Fails open.** If Cachetoast errors, you see a warning and your prompt goes through.

```text
Cachetoast held this prompt!

This ~180k-token session has been idle 55 min with a 1h cache TTL, so its prompt cache has likely expired and continuing would re-read it all as uncached input.
Send it again to continue here OR start a new session (not resume or fork) and run:
 /cachetoast-handoff claude-0123456789abcdef01234567
(The handoff includes your prompt.)
```

The handoff is a local extract (original and latest requests, latest assistant text, compaction summary, Git status), not a model summary. Use it in a **fresh** session in the same repo; resume and fork keep the old history. Copy the command from the notice: `/cachetoast-handoff KEY` in Claude Code (CLI or desktop) or `$cachetoast-handoff KEY` in Codex. The key selects that session even if other sessions have been held since. Without a key, the command loads that agent's most recently held handoff. In Pi, `/handoff` opens the fresh session for you.

Replacement sessions use `CT - <subject>`, keeping the previous session's name when available or using its work subject. Pi sets it when opening the session. Claude/Codex handoffs ask the agent to set it through an available naming tool; without one, they provide `/rename CT - <subject>` and continue. The title is for finding the session; the key still selects its saved handoff.

## Cache TTL

Cachetoast works out each session's cache lifetime instead of asking:

- **Claude Code:** read from the session. Every response records which TTL its cache write used (1h on Pro/Max, 5m on API keys, cloud providers, or usage credits), so switching to credits shortens it automatically.
- **Codex:** 30m, the minimum for GPT-5.6 and later. Older models aren't supported.
- **Pi:** guessed from the model: 5m for Claude models (1h from Anthropic with `PI_CACHE_RETENTION=long`), otherwise 30m.

Anything unknown assumes 30m, the shortest lifetime among current large-context models apart from Claude's 5m, which Claude sessions report themselves. A prompt is held at the TTL minus up to 5 minutes (5m → 4 min, 30m → 25 min, 1h → 55 min, 24h → 23 h 55 min), and the notice states the TTL it used.

If a guess is wrong, override it with `init --pi-cache-ttl 1h` (also `--codex-cache-ttl`, `--claude-cache-ttl`; values `5m`, `30m`, `1h`, `24h`). Overrides are saved per user in `~/.config/cachetoast/config.json` (or `$XDG_CONFIG_HOME`), or per repo in the gitignored `.cachetoast/local.json`, same format. A TTL a Claude session reports always wins.

## Commands

```sh
node .cachetoast/runtime/bin/cachetoast.mjs status              # sessions, sizes, TTLs, policy
node .cachetoast/runtime/bin/cachetoast.mjs handoff --key KEY   # print a saved handoff (or --provider claude for the latest)
node .cachetoast/runtime/bin/cachetoast.mjs uninstall           # restore original files
```

## Per agent

| | Claude Code / Codex | Pi |
| --- | --- | --- |
| Integration | `UserPromptSubmit` and `Stop` hooks, plus a handoff command (Claude) or skill (Codex) | In-process extension (`.pi/extensions`) |
| Context size | Transcript tail | `getContextUsage()` |
| Cache TTL | Claude: from the transcript. Codex: 30m | Guessed from the model |
| Compaction cap | `CLAUDE_CODE_AUTO_COMPACT_WINDOW` / `model_auto_compact_token_limit` | Extension compacts once idle |
| Held prompt | Send it again (Up-arrow recalls it in the Codex CLI) | Put back in the editor; Enter sends it |
| Handoff | New session, then `/cachetoast-handoff KEY` (Claude) or `$cachetoast-handoff KEY` (Codex) | `/handoff` opens a fresh session with the prompt in the editor |
| Cache status | | Footer: warm countdown, then cold |

## What gets committed

Commit `.cachetoast/runtime`, `.cachetoast/config.json`, and the agent settings, hooks, and handoff command/skill. Keep `local.json` (per-repo TTL overrides), `state/`, `handoffs/`, and `manifest.json` local (they're added to `.gitignore`). Handoffs contain conversation excerpts.

`init` and `update` are idempotent and keep unrelated settings and hooks. `uninstall` restores the original bytes and removes its local state and handoffs. If you've edited the managed files since, they stop so you can reconcile by hand.

## Limits

- A local clock estimates cache expiry; it can't see the provider's cache. "May cause" is deliberate.
- Disabled or untrusted hooks, and hook timeouts, mean no hold.
- Provider hooks, transcript formats, and settings can change. Verified with Claude Code 2.1.285, Codex CLI 0.159.2, and Pi 0.85.1.
- Background research and sources: [docs/research.md](docs/research.md).

## Develop

```sh
npm test && npm run demo
```

## Author

Cachetoast is built and maintained by R. Hunter Harris at [Hunter Software Consulting](https://huntersoftwareconsulting.com), which offers fractional product and technology leadership for B2B SaaS.

## License

[MIT](LICENSE) © 2026 R. Hunter Harris, Hunter Software Consulting: use, modify, and redistribute freely; keep the copyright and license notice in copies. Inspired in part by [Antiburn](https://github.com/antiburn/antiburn); no Antiburn code is included.
