# Blackhole for Oh My Pi

Deterministic compaction + observational memory extension for Oh My Pi, inspired by [pi-blackhole](https://github.com/k0valik/pi-blackhole).

## What it does

- **`/blackhole`** — Manual deterministic compaction. Extracts structural summary (goal, files, commits, blockers, preferences) without LLM call, then compacts via native `ctx.compact()`.
- **`/blackhole-memory`** — Show observation/reflection ledger status (`status`, `view`, `full`).
- **`/blackhole-recall <query>`** — Search session history and memory ledger.
- **`/blackhole-export`** — Export distilled project memory to markdown.
- **Auto-compaction** — Fires at configurable token threshold (default 81k).
- **Three background workers** — Observer (extracts observations), Reflector (distills reflections), Dropper (prunes low-value observations). Runs on `turn_end` and `agent_end`.

## Install

The extension is already at:
```
~/.omp/agent/extensions/blackhole.ts
```

Oh My Pi auto-discovers extensions from `~/.omp/agent/extensions/`. Just restart `omp` or run `/reload`.

## Config

Edit `~/.omp/agent/blackhole-config.json`:

```json
{
  "compaction": "auto",
  "compactAfterTokens": 81000,
  "memory": true,
  "observeAfterTokens": 8000,
  "observationsPoolMaxTokens": 4000,
  "observerModel": "",
  "reflectorModel": "",
  "dropperModel": "",
  "sessionFallback": true,
  "midRunCompaction": "off",
  "compactionSummaryMode": "replace",
  "exportPath": "blackhole-export.md",
  "debug": false
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `compaction` | `"auto"` | `"auto"` = fire at threshold; `"manual"` = only `/blackhole`; `"off"` = disabled |
| `compactAfterTokens` | `81000` | Token threshold for auto-compaction |
| `memory` | `true` | Enable observational memory workers |
| `observeAfterTokens` | `8000` | Token delta before Observer runs |
| `observationsPoolMaxTokens` | `4000` | Max active observation pool before Dropper prunes |
| `debug` | `false` | Log debug info to stderr |
| `deferCompactionToAgentEnd` | `true` | `true` = wait for agent_end before compacting; `false` = compact immediately at threshold (may interrupt agent) |

## Commands

| Command | Description |
|---------|-------------|
| `/blackhole` | Manual compact — structural summary + memory injection |
| `/blackhole settings` | Show config file path |
| `/blackhole om-off` / `om-on` | Toggle observational memory |
| `/blackhole cleanup` | Remove orphaned pending files |
| `/blackhole changelog` | Show upstream changelog link |
| `/blackhole-memory` | Memory pipeline status |
| `/blackhole-memory view` | Show active memory (copies to clipboard) |
| `/blackhole-memory full` | Show all memory including dropped |
| `/blackhole-recall <query>` | Search session history |
| `/blackhole-export` | Export to `blackhole-export.md` |

## Agent-facing tool

The extension registers a `blackhole_recall` tool the LLM can call to search session history and memory.

## How it works

### Compaction Deferral
By default (`deferCompactionToAgentEnd: true`), auto-compaction waits until the agent finishes its current work cycle (`agent_end`) before compacting. This prevents interrupting the agent mid-task.

Set `deferCompactionToAgentEnd: false` to compact immediately at token threshold — matches legacy pi-blackhole behavior but may cut off in-progress agent work.

### Compaction
1. `/blackhole` or auto-trigger fires.
2. `extractCompactionContext()` scans recent messages for files, commits, blockers, preferences, and goal.
3. `buildStructuralSummary()` renders a deterministic sectioned summary.
4. `ctx.compact()` runs native compaction with the structural summary as `customInstructions`.
5. Memory block (`<reflections>` + `<observations>`) is injected via `session_before_compact` hook.

### Observational Memory
1. **Observer** runs on `turn_end` when token delta ≥ `observeAfterTokens`. Extracts file paths, commands, decisions from recent messages. No LLM call — deterministic regex extraction.
2. **Reflector** runs on `agent_end`. Groups observations by turn and creates durable reflections.
3. **Dropper** runs when observation pool exceeds `observationsPoolMaxTokens`. Scores observations by information density and drops the bottom 25%.

### Persistence
- Ledger: `~/.omp/agent/blackhole/<sessionId>-ledger.json`
- Survives compaction because it's stored outside the session transcript.
- Rehydrated on `session_start`.

## Differences from pi-blackhole

| Feature | pi-blackhole | omp-blackhole |
|---------|-----------|---------------|
| Compaction | Deterministic structural summary | Same |
| Observer/Reflector/Dropper | LLM-based with fallback chains | Deterministic regex extraction (no LLM cost) |
| Recall | BM25+SimHash64+c-TF-IDF | Simple substring + ID lookup |
| Export | Markdown with topic badges | Plain markdown |
| Mid-run compaction | `resume`/`pause` | Not yet implemented |
| Append mode | `S1 \| S2 \| …` | `replace` only |

## Limitations

- No LLM-based observation extraction (zero-cost, but less semantic).
- No cross-session recall (per-session ledger only).
- No `append` compaction mode.
- No model fallback chains (no LLM calls to fall back from).

## License

MIT
