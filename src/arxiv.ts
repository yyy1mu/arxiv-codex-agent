// Shared paper types, the gated HTTP fetch, and e-print source download.
// Discovery now comes from per-category RSS (rss.ts), not the arXiv search API.
import { EPRINT_BASE, MAX_RETRIES, USER_AGENT } from "./config.ts";
import type { RateGate } from "./gate.ts";

export interface Paper {
  id: string; // includes version suffix, e.g. 2606.01234v3
  title: string;
  published: string; // first-version (v1) submission time
  publishedDate: Date;
  updated: string; // most-recent-version submission time
  updatedDate: Date;
  version: number; // parsed from id; 1 = first submission, >1 = revision
  summary: string;
}

export interface MatchedPaper extends Paper {
  category: string; // security-domain label assigned by the LLM filter
}

export type SourceKind = "tex" | "pdf" | "none";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET `url` as text, gated and retried (429/5xx → backoff + global penalize).
 *  Shared by RSS discovery (rss.ts) and any other arXiv API call. */
export async function fetchWithBackoff(url: string, gate: RateGate): Promise<string> {
  let lastErr = "";
  for (let retry = 0; retry < MAX_RETRIES; retry++) {
    const wait = 2 ** retry * 10_000;
    let res: Response;
    try {
      await gate.pass(); // every call-start (incl. retries) goes through the shared rate gate
      res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    } catch (e) {
      // Network-level failure (DNS/connection reset/timeout) — transient.
      lastErr = String(e);
      console.log(`  ⚠️ arXiv 网络错误，retrying in ${wait / 1000}s (${retry + 1}/${MAX_RETRIES})...`);
      await sleep(wait);
      continue;
    }
    // Retry on 429 (rate limit) and 5xx (transient server errors, e.g. 503).
    if (res.status === 429 || res.status >= 500) {
      lastErr = `${res.status} ${res.statusText}`;
      // Honor a Retry-After header if present (seconds); else exp backoff + jitter.
      const retryAfter = Number(res.headers.get("retry-after"));
      const delay = (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : wait) + Math.random() * 1000;
      console.log(`  ⚠️ arXiv ${lastErr}, retrying in ${Math.round(delay / 1000)}s (${retry + 1}/${MAX_RETRIES})...`);
      gate.penalize(delay); // per-IP throttle → back off the whole pipeline, not just this call
      await sleep(delay);
      continue;
    }
    if (!res.ok) throw new Error(`arXiv API ${res.status}: ${res.statusText}`); // 4xx → not retryable
    return res.text();
  }
  throw new Error(`arXiv 多次重试仍失败 (${MAX_RETRIES} 次): ${lastErr}`);
}

/** Download e-print: tar.gz (LaTeX source) preferred, PDF fallback. The
 *  call-start passes through the shared rate gate (same channel as search). */
export async function downloadSource(id: string, saveDir: string, gate: RateGate): Promise<SourceKind> {
  const url = `${EPRINT_BASE}/${id}`;
  console.log(`  ⬇️ ${url}`);

  let res: Response;
  try {
    await gate.pass();
    res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  } catch (e) {
    console.log(`  ❌ network error: ${e}`);
    return "none";
  }
  if (!res.ok) {
    console.log(`  ❌ HTTP ${res.status}`);
    // A throttled download is the same per-IP signal — slow the whole pipeline.
    if (res.status === 429 || res.status >= 500) gate.penalize(30_000);
    return "none";
  }

  const ct = res.headers.get("content-type") ?? "";
  const buf = Buffer.from(await res.arrayBuffer());

  if (["x-eprint-tar", "gzip", "x-gzip", "octet-stream"].some((t) => ct.includes(t))) {
    await Bun.write(`${saveDir}/${id}.tar.gz`, buf);
    console.log("  ✅ LaTeX source");
    return "tex";
  }
  if (ct.includes("application/pdf")) {
    await Bun.write(`${saveDir}/${id}.pdf`, buf);
    console.log("  ⚠️ PDF only (no source)");
    return "pdf";
  }
  console.log(`  ❓ unknown content-type: ${ct}`);
  return "none";
}
