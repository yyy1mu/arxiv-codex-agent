# arXiv Security Agent

Daily arXiv security paper fetch → LLM review → score agent (Bun + TypeScript).

Automatically discovers, downloads, reviews, and scores security-related papers from arXiv RSS feeds, then generates a daily summary with ranking, category stats, and Top-9 summary cards.

## Prerequisites

- [Bun](https://bun.sh/) runtime
- [Google Chrome](https://www.google.com/chrome/) (for card PNG generation)
- A Codex-compatible local API endpoint

## Setup

```bash
bun install
```

## Configuration

Copy the sample environment file and fill in your local Codex-compatible API
endpoint and key:

```bash
cp .env.example .env
```

Required values:

- `CODEX_BASE_URL` - Codex-compatible API base URL
- `CODEX_API_KEY` - API key for that endpoint
- `ARXIV_AGENT_SDK_MODEL` - model name used by the review agent
- `ARXIV_AGENT_CODEX_PROVIDER` - Codex CLI model provider name for this local
  endpoint; defaults to `local-codex`

The app uses `@openai/codex-sdk` as the agent layer. For local OpenAI-compatible
endpoints, it registers a Codex model provider with `supports_websockets=false`
so Codex keeps its agent workflow while using the endpoint's HTTP Responses
transport instead of the CLI websocket transport.

## Run

```bash
bun run src/index.ts --workers 1
```

Or using npm scripts:

```bash
bun run start
bun run today
```

### CLI Options

```bash
bun run src/index.ts [YYYYMMDD] [--concurrency N] [--limit N] [--workers N] [--out DIR]
```

| Option | Default | Description |
|--------|---------|-------------|
| `YYYYMMDD` | today | Output folder name (RSS always fetches the latest) |
| `--concurrency` | 3 | Max concurrent LLM review tasks |
| `--limit` | 0 (no limit) | Cap number of papers to review |
| `--workers` | 4 | Download worker pool size |
| `--out` | `./papers` | Output root directory |

### Examples

```bash
# Review today's papers
bun run start

# Review papers for a specific date
bun run src/index.ts 20260608

# Limit to 5 papers, 2 concurrent reviews
bun run src/index.ts --limit 5 --concurrency 2

# Custom output directory
bun run src/index.ts --out ./my-papers
```

## Output Structure

```
papers/{YYYYMMDD}/
├── summary.md              # Daily overview + ranking table
├── reviews/
│   ├── {id}.md             # Per-paper standalone review
│   └── ...
├── cards/
│   ├── {id}.html           # Card HTML
│   └── {id}.png            # Card PNG screenshot
├── {id}.tar.gz             # LaTeX source (if available)
├── {id}.pdf                # PDF fallback (if no LaTeX source)
└── {id}/                   # Extracted LaTeX directory
```

## Type Check

```bash
bun run typecheck
```

## Monitored Categories

- `cs.CR` — Cryptography and Security
- `cs.NI` — Networking and Internet Architecture
- `cs.SE` — Software Engineering
- `cs.DC` — Distributed Computing
- `cs.PL` — Programming Languages

## License

MIT
