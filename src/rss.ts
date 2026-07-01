// Per-category RSS discovery (replaces the arXiv search API).
//
// Each category has its own full daily Atom feed at `${RSS_BASE}/${cat}`
// (e.g. https://rss.arxiv.org/atom/cs.SE). We fetch the WHOLE feed — no
// pagination, no date window — and hand every entry to the LLM relevance filter
// (review.ts). The fetch is gated like everything else (shared rate limit).
import { XMLParser } from "fast-xml-parser";
import { fetchWithBackoff, type Paper } from "./arxiv.ts";
import { RSS_BASE } from "./config.ts";
import type { RateGate } from "./gate.ts";

export interface RssEntry extends Paper {
  announceType: string; // "new" | "replace" | "cross" | "replace-cross" | ...
}

const xml = new XMLParser({ ignoreAttributes: false, trimValues: true });

/** Fetch one category's full RSS feed and parse every entry. */
export async function fetchRssEntries(cat: string, gate: RateGate): Promise<RssEntry[]> {
  const body = await fetchWithBackoff(`${RSS_BASE}/${cat}`, gate);
  const feed = xml.parse(body)?.feed;
  if (!feed) return [];
  const raw = feed.entry ? (Array.isArray(feed.entry) ? feed.entry : [feed.entry]) : [];
  return raw
    .map((e: any): RssEntry => {
      // <id>oai:arXiv.org:2606.04017v1</id> → "2606.04017v1"
      const id = String(e.id ?? "")
        .replace(/^oai:arXiv\.org:/i, "")
        .trim();
      const title = String(e.title ?? "").replace(/\s+/g, " ").trim();
      // <summary> is "arXiv:<id> Announce Type: <type> \nAbstract: <text>" —
      // strip the boilerplate prefix down to the abstract.
      const summary = String(e.summary ?? "")
        .replace(/\s+/g, " ")
        .replace(/^arXiv:\S+\s+Announce Type:\s*[\w-]+\s*/i, "")
        .replace(/^Abstract:\s*/i, "")
        .trim();
      const announceType = String(e["arxiv:announce_type"] ?? "").trim();
      const published = String(e.published ?? "").trim();
      const updated = String(e.updated ?? published).trim();
      const version = Number(id.match(/v(\d+)$/)?.[1] ?? 1);
      return {
        id,
        title,
        summary,
        published,
        publishedDate: new Date(published),
        updated,
        updatedDate: new Date(updated),
        version,
        announceType,
      };
    })
    .filter((p: RssEntry) => p.id && p.title);
}
