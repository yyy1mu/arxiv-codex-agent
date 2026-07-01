// Central configuration: RSS feeds, security domains, runtime knobs.

// Discovery is per-category RSS (full daily feed), not the arXiv search API.
// Each category is fetched separately from `${RSS_BASE}/${cat}` (Atom), then an
// LLM does a relevance pass (see review.ts `filterInteresting`).
export const RSS_BASE = "https://rss.arxiv.org/atom";
export const EPRINT_BASE = "https://arxiv.org/e-print";

// Contact UA per arXiv etiquette.
export const USER_AGENT = "arxiv-security-agent/1.0 (contact: yx0161@outlook.com)";

// One RSS feed per category; relevance is decided by the LLM filter, not regex.
export const CATEGORY_LIST = ["cs.CR", "cs.NI", "cs.SE", "cs.DC", "cs.PL"];

// Rate limiting (arXiv has unofficial ~1 req/3s limits). ONE shared channel
// serves both RSS fetches and e-print downloads — a single RateGate at this
// interval gates every call-start (see gate.ts / scraper.ts).
export const FETCH_GATE_MS = 3_000; // min spacing between any two call-starts
export const FETCH_JITTER_MS = 2_000; // + up to this much random extra (breaks the lockstep that resonates with arXiv's rolling window → fewer 429s)
export const MAX_RETRIES = 8; // 429 exponential backoff: 2^n * 10s

// Defaults (overridable via CLI flags / env).
export const DEFAULT_REVIEW_CONCURRENCY = 3;
// Worker pool sharing the gate. M ≈ ⌈max-call-duration / gate-interval⌉ + 1 so a
// download slower than one gate interval can't idle the rate-limited channel.
export const DEFAULT_FETCH_WORKERS = 4;

// LLM calls go through the Codex SDK. Bun loads `.env` automatically at
// startup, so keep endpoint URLs and keys out of source control.
process.env.ARXIV_AGENT_SDK_MODEL ??= "deepseek-v4-flash-ascend";

// The security domain taxonomy. The LLM relevance filter (review.ts) tags each
// selected paper with one of these labels; summary.ts uses them for stats.
export const SECURITY_DOMAINS = [
  "Network Security",
  "Web Security",
  "Code Audit",
  "PLC/ICS Security",
  "Reverse Engineering",
  "Malware/Ransomware",
  "Firmware/IoT",
  "Smart Contract/Blockchain",
  "Prompt Injection/AI Security",
  "Protocol Security",
];
