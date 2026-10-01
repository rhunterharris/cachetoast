# Verified behavior and design decisions

Checked October 1, 2026 against primary provider documentation. Installed clients: Codex CLI 0.159.2 and Claude Code 2.1.285. No paid inference or quota experiment was performed. The private discussion was used to identify questions; its claims were not treated as documentation.

## What survives cache expiry

Cache expiry removes reusable inference state, not the transcript or its context window. Continuing sends the current context again. Earlier compacted-away history is not magically restored. Native compaction changes the prompt prefix and can require a new cache write. A handoff prepared locally avoids submitting long history solely to summarize it.

## Claude: the assumption needs correction

Claude’s current docs say a cold `/compact` summarization request reprocesses the full history. Warm compaction can reuse the prefix. Claude Code already has one cache-aware path: on Pro/Max, **resuming** (`--resume` or `/resume`) a session inactive for more than about an hour and over 100,000 tokens opens a dialog offering resume-from-summary or resume-as-is (documented on the sessions page; the strings are present in 2.1.285, and the dialog may be feature-gated). It does not cover typing into a terminal that stayed open while idle, which is the case Cachetoast guards. “Claude has no cache-aware behavior” is too broad, and its 100K threshold motivates Cachetoast’s minimum context size.

Included subscription main turns normally request one hour. API keys, cloud providers, and usage-credit billing normally use five minutes. Most helpers, including compaction, use five minutes unless overridden. Explicit controls exist: `promptCacheTtl` and `subagentPromptCacheTtl` settings, `CLAUDE_CODE_PROMPT_CACHE_TTL` (`5m`/`1h`), `ENABLE_PROMPT_CACHING_1H`, and `FORCE_PROMPT_CACHING_5M`. Switching from included usage to credits can shorten the effective lifetime. These are per-request controls, not a universal one-hour guarantee. Each assistant transcript record's `usage.cache_creation` splits cache writes into `ephemeral_1h_input_tokens` and `ephemeral_5m_input_tokens`, so Cachetoast reads the TTL a session actually gets from its latest write rather than from settings or billing. See [Claude Code prompt caching](https://code.claude.com/docs/en/prompt-caching).

Anthropic’s API supports five-minute and one-hour cache writes, priced at 1.25× and 2× ordinary input respectively. Reads are usually 0.1× with model-specific exceptions. Hits refresh the TTL. This is API pricing, not a formula for subscription quota. See [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

Claude plan usage is shared across Claude and Claude Code. API-key authentication can use separate API billing. Exact subscription allowance savings should not be inferred from API-dollar estimates. See [Claude Pro/Max usage and billing](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan).

## OpenAI API versus Codex quota/credits

Current API docs distinguish model generations. GPT-5.6 and later support a default/minimum 30-minute cache lifetime and charge 1.25× uncached input for cache writes. GPT-5.6+ set this with `prompt_cache_options.ttl` (only `30m`). Older models use `prompt_cache_retention`: `in_memory` entries commonly last 5–10 idle minutes, up to an hour; `24h` extended retention can last a day and is the default for organizations without Zero Data Retention where both are supported. GPT-5.5 supports only `24h`. Prefix changes and routing also affect hits. A single “30-minute Codex cache” rule cannot be applied to every model and billing mode. Codex transcripts record no TTL, so Cachetoast supports GPT-5.6 and later only and assumes their 30-minute minimum. See [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).

Codex credit billing explicitly has no separate cache-write charge; API-key usage follows API pricing. Cached and uncached input have distinct credit rates. Included subscription usage is not determined solely by credit prices. Consequently “rehydration is free/irrelevant on subscriptions” does not follow. No public source reviewed establishes a universal exact quota weighting or Codex-client retention contract. See [Codex pricing and limits](https://learn.chatgpt.com/docs/pricing).

OpenAI offers threshold-based server compaction and a standalone compact endpoint accepting the current context. The compacted output can include opaque state. These documented flows do not establish a blanket provider difference where only OpenAI reads cold history before compaction. Both require context to produce a semantic summary; a cache hit or an existing saved summary changes that cost. See [OpenAI compaction](https://developers.openai.com/api/docs/guides/compaction).

## Compaction settings

Codex documents `model_auto_compact_token_limit`, with model defaults when unset. Its scope defaults to total active context; `body_after_prefix` counts only growth after a carried prefix. Repo settings and hooks can be overridden or disabled at higher priority. Cachetoast installs a root threshold of at most 250000 without changing model capacity. See [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

Claude supports an auto-compact window of 100K–1M and caps it at model capacity. The environment variable accepts a plain token count. Default timing differs by model, with large windows able to grow far beyond 250K. Cachetoast sets the window to 250000 or keeps an earlier setting. Exact observed cutoff can be earlier due to reserves and native compaction behavior. See [Claude model configuration](https://code.claude.com/docs/en/model-config) and [environment variables](https://code.claude.com/docs/en/env-vars).

A universal “shorter sessions always perform better” or “250K is optimal” claim was not verified. 250K is the requested operational ceiling. Native compaction can lose detail; checkpoints preserve explicit constraints and next steps.

## Available hooks

Both current clients expose command hooks, including `UserPromptSubmit`, `Stop`, and compaction events. `UserPromptSubmit` supports blocking before the model processes the prompt. A `systemMessage` only appears after the prompt is sent, when the cost is already paid, so Cachetoast holds the first cold prompt once per idle period (`decision: "block"`) and lets it through when sent again. Codex's CLI adds a submitted prompt to message history before hooks run, so Up-arrow recalls a held prompt. Neither client offers a repo-installable surface visible before typing, so the hold is the only point where the cost can still be avoided. Neither documented lifecycle provides a portable command that requests in-process `/compact` while an arbitrary CLI session is idle. Cachetoast therefore performs deterministic local extraction at the next prompt, leaving live transcripts intact. Because extraction needs no model call, preparing it earlier with a timer would cost the same and only add moving parts.

Codex loads trusted repo hooks from `.codex/hooks.json`; new or changed hook definitions require review in `/hooks`. Hooks run with the session cwd, which may be a subdirectory. See [Codex hooks](https://learn.chatgpt.com/docs/hooks).

Claude’s `UserPromptSubmit` hooks fail open on timeout or non-zero exit (other than exit 2), and `Stop` does not fire on user interrupt. Cachetoast therefore fails open on its own errors too, and reads response timestamps from the transcript to cover interrupted turns. It uses only `UserPromptSubmit` and `Stop`; native compaction summaries are read from the transcript. See [Claude hooks](https://code.claude.com/docs/en/hooks).

## Pi

Checked against the docs shipped with Pi 0.85.1. Extensions are TypeScript modules loaded in-process via jiti from `.pi/extensions/` after project trust. The `input` event fires before skill/template expansion and agent start; `agent_settled` fires once Pi will not continue automatically. `ctx.getContextUsage()` reports current context tokens. `ctx.compact()` aborts any running turn before compacting, so Cachetoast only calls it when idle. Auto-compaction triggers at `contextWindow - compaction.reserveTokens`; there is no absolute token setting. `ctx.newSession({ parentSession, withSession })` creates a linked session; only the replacement context is valid inside `withSession`. `PI_CACHE_RETENTION=long` requests extended provider caching: 1h `cache_control` for Anthropic models that support it and 30m for OpenAI GPT-5.6+. Pi's usage records carry no TTL, so Cachetoast guesses one from `ctx.model`: 5m for Claude models (1h from Anthropic with the long setting), otherwise 30m. Pi compaction requests use fresh routing session IDs and disable cache writes where supported.

## Cost intuition

Let H be retained history tokens, S be handoff tokens, R the cache-read rate, W the write/uncached rate, O compaction output cost, and G the re-grounding cost of a fresh session (re-reading files and rebuilding understanding over several requests). Cold continuation of the full history roughly costs H×W. A fresh session from a local handoff roughly costs S×W + G, plus some lost detail. A warm semantic compact followed by a cold continuation roughly costs H×R + O + S×W. Rotation only pays off when H×W clearly exceeds S×W + G, so Cachetoast ignores sessions below a minimum context size (default 100K). These are illustrative components, not invoices; stable prefixes, routing, provider behavior, output usage, and plan accounting affect the result.

After native compaction the next request writes a new cache whether the user continues or starts fresh, so compaction is not itself a reason to rotate. Compacting after expiry may pay for the old history before obtaining a smaller context. Repeated early compaction also has overhead. No keepalive requests are sent merely to extend a cache.

## Inspiration

[Antiburn](https://antiburn.com/) highlights long context and cache rehydration in local coding-agent usage. Its [open source repository](https://github.com/antiburn/antiburn) is credited as inspiration. Cachetoast implements a narrow repo bootstrap and handoff policy independently. The source discussion is omitted from distribution.
