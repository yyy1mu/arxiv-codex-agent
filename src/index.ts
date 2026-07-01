#!/usr/bin/env bun
// arXiv security paper agent — RSS discovery + LLM filter, feeding a review
// pipeline:
//   1. per-category RSS (full feed, gated) → LLM relevance filter per category
//   2. interesting papers → download (shared 3s gate + worker pool)
//   3. each download → reviewed concurrently as it lands → overview → summary
//
// Usage:
//   bun run src/index.ts [YYYYMMDD] [--concurrency N] [--limit N] [--workers N]
//
// YYYYMMDD only names the output folder (RSS always reflects the latest
// announcement day); default: today.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CATEGORY_LIST, DEFAULT_FETCH_WORKERS, DEFAULT_REVIEW_CONCURRENCY, FETCH_GATE_MS, FETCH_JITTER_MS } from "./config.ts";
import { type MatchedPaper, type SourceKind } from "./arxiv.ts";
import { fetchRssEntries } from "./rss.ts";
import { RateGate } from "./gate.ts";
import { runDownloadPool } from "./scraper.ts";
import { filterInteresting, reviewPaper, synthesizeOverview } from "./review.ts";
import { readExistingReview, writeReviewFile, writeSummary, type ReviewedPaper } from "./summary.ts";
import { generateCards } from "./cards.ts";

const CARD_TOP_N = 9;

interface Args {
  date: string;
  concurrency: number;
  limit: number; // cap papers downloaded+reviewed (0 = no cap)
  workers: number; // download worker-pool size (shares the rate gate)
  outDir: string;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  let date = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) flags.set(a.slice(2), argv[++i] ?? "");
    else if (/^\d{8}$/.test(a)) date = a;
  }
  const num = (k: string, d: number) => (flags.has(k) ? Number(flags.get(k)) : d);
  return {
    date: date || new Date().toISOString().slice(0, 10).replace(/-/g, ""),
    concurrency: num("concurrency", DEFAULT_REVIEW_CONCURRENCY),
    limit: num("limit", 0),
    workers: num("workers", DEFAULT_FETCH_WORKERS),
    outDir: flags.get("out") ?? join(process.cwd(), "papers"),
  };
}

/** Bounded-concurrency runner: schedule fn now, run it once a slot is free. */
function pLimit(n: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  const release = () => {
    active--;
    queue.shift()?.();
  };
  return <R>(fn: () => Promise<R>): Promise<R> =>
    new Promise<R>((resolve, reject) => {
      const run = () => {
        active++;
        fn().then(resolve, reject).finally(release);
      };
      if (active < n) run();
      else queue.push(run);
    });
}

/** Locate an already-downloaded source for a paper, or null. */
async function existingKind(id: string, saveDir: string): Promise<SourceKind | null> {
  if (await Bun.file(join(saveDir, `${id}.tar.gz`)).exists()) return "tex";
  if (await Bun.file(join(saveDir, `${id}.pdf`)).exists()) return "pdf";
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const saveDir = join(args.outDir, args.date);
  await mkdir(saveDir, { recursive: true });

  console.log("=== arXiv 安全论文 Agent (RSS) ===");
  console.log(`日期(目录名): ${args.date} | 模型: ${process.env.ARXIV_AGENT_SDK_MODEL ?? "deepseek-v4-flash"}`);
  console.log(`输出目录: ${saveDir}`);
  console.log("-".repeat(50));

  const gate = new RateGate(FETCH_GATE_MS, FETCH_JITTER_MS);

  // Phase 1: per-category RSS (gated) → LLM relevance filter. RSS fetches are
  // serialized by the gate; the LLM filters run concurrently, overlapping the
  // next category's gated fetch. Papers are de-duped across categories by base id.
  console.log(`\n=== RSS 抓取 + LLM 初筛 (${CATEGORY_LIST.length} 个领域) ===`);
  const filterTasks: Promise<MatchedPaper[]>[] = [];
  for (const cat of CATEGORY_LIST) {
    let entries;
    try {
      entries = await fetchRssEntries(cat, gate);
    } catch (e) {
      console.log(`  ⚠️ ${cat} RSS 抓取失败，跳过: ${String(e).slice(0, 120)}`);
      continue;
    }
    console.log(`  📡 ${cat}: RSS ${entries.length} 篇 → LLM 初筛中...`);
    filterTasks.push(
      filterInteresting(cat, entries).then((picked) => {
        console.log(`  ✅ ${cat}: 选中 ${picked.length}/${entries!.length}`);
        return picked;
      }),
    );
  }

  const seen = new Set<string>();
  let interesting = (await Promise.all(filterTasks)).flat().filter((p) => {
    const base = p.id.replace(/v\d+$/, "");
    if (seen.has(base)) return false; // same paper picked from another category
    seen.add(base);
    return true;
  });
  if (args.limit > 0) interesting = interesting.slice(0, args.limit);

  if (interesting.length === 0) {
    console.log("\n初筛后没有与安全相关的论文。");
    return;
  }
  const found = interesting.length;

  // Phase 2: download (gated worker pool) → review (bounded-concurrency pipeline).
  const gateDesc = `${FETCH_GATE_MS / 1000}~${(FETCH_GATE_MS + FETCH_JITTER_MS) / 1000}s`;
  console.log(`\n=== 下载(worker池 ${args.workers}·共享${gateDesc}闸门) → 评测(并发 ${args.concurrency})：${found} 篇 ===`);
  const limit = pLimit(args.concurrency);
  const tasks: Promise<ReviewedPaper | null>[] = [];

  const reviewOne = (p: MatchedPaper, kind: SourceKind, i: number) =>
    limit(async (): Promise<ReviewedPaper | null> => {
      // Reuse an existing summary if present — skip the LLM entirely.
      const cached = await readExistingReview(saveDir, p.id);
      if (cached) {
        console.log(`  ↩️ [#${i}] ${p.id} 已有总结 → ${cached.review.score.toFixed(1)}/10 (复用 reviews/${p.id}.md)`);
        return { ...p, ...cached };
      }
      const src = kind === "tex" ? "LaTeX" : kind === "pdf" ? "PDF" : "metadata-only";
      const sourceNote = p.version > 1 ? `${src} · v${p.version} 更新` : `${src} · 首次提交`;
      console.log(`  🚀 [#${i}] 开始评测 ${p.id} (${sourceNote})`); // prints when a concurrency slot opens
      try {
        const review = await reviewPaper(p, saveDir, kind);
        const reviewed: ReviewedPaper = { ...p, review, sourceNote };
        await writeReviewFile(saveDir, reviewed); // persist this paper's review now
        console.log(`  ✅ [#${i}] ${p.id} → ${review.score.toFixed(1)}/10 (${sourceNote}) → reviews/${p.id}.md`);
        return reviewed;
      } catch (e) {
        console.log(`  ❌ [#${i}] ${p.id} 评测失败: ${e}`);
        return null;
      }
    });

  // Each downloaded paper is reviewed immediately, overlapping later downloads.
  await runDownloadPool(interesting, {
    gate,
    saveDir,
    workers: args.workers,
    existingKind: (id) => existingKind(id, saveDir),
    alreadyReviewed: (id) => Bun.file(join(saveDir, "reviews", `${id}.md`)).exists(),
    onDownloaded: (p, kind, i) => tasks.push(reviewOne(p, kind, i)),
  });

  console.log(`\n⏳ 等待 ${tasks.length} 篇评测完成...`);
  const reviewed = await Promise.all(tasks);
  const ok = reviewed.filter((r): r is ReviewedPaper => r !== null);
  if (ok.length === 0) {
    console.log("\n所有评测均失败，未生成汇总。");
    process.exitCode = 1;
    return;
  }

  // Daily summary: skip entirely if today's summary.md already exists.
  if (await Bun.file(join(saveDir, "summary.md")).exists()) {
    console.log("\n=== 当日 summary.md 已存在，跳过综述与汇总 ===");
  } else {
    console.log(`\n=== 生成整体综述 ===`);
    let overview = "";
    try {
      overview = await synthesizeOverview(
        args.date,
        ok.map((p) => ({ id: p.id, title: p.title, category: p.category, score: p.review.score, body: p.review.body })),
      );
      console.log("  ✅ 综述完成");
    } catch (e) {
      console.log(`  ⚠️ 综述生成失败，将留空: ${e}`);
    }
    const summaryPath = await writeSummary(args.date, saveDir, ok, overview);
    console.log(`📄 汇总: ${summaryPath}`);
  }

  // Top-9 summary cards: HTML (template + SDK-extracted fields) → PNG.
  const top = [...ok].sort((a, b) => b.review.score - a.review.score).slice(0, CARD_TOP_N);
  console.log(`\n=== 生成 Top ${top.length} 卡片 (HTML→PNG) ===`);
  await generateCards(saveDir, top);

  console.log(`\n=== 完成: ${ok.length}/${found} 篇评测 ===`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exitCode = 1;
});
