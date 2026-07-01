// Render the per-paper reviews and the sorted summary.md.
import { join } from "node:path";
import type { MatchedPaper } from "./arxiv.ts";
import type { Review } from "./review.ts";

export interface ReviewedPaper extends MatchedPaper {
  review: Review;
  sourceNote: string; // e.g. "LaTeX", "PDF", "metadata-only"
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function fmtDate(yyyymmdd: string): string {
  const y = yyyymmdd.slice(0, 4);
  const m = yyyymmdd.slice(4, 6);
  const d = yyyymmdd.slice(6, 8);
  const wd = WEEKDAYS[new Date(`${y}-${m}-${d}T00:00:00Z`).getUTCDay()] ?? "";
  return `${y}-${m}-${d} (${wd})`;
}

/**
 * The "big" summary: LLM-synthesized overview on top, then a ranking table
 * (each row links to its standalone per-paper review file) + category stats.
 * Per-paper details live in reviews/{id}.md, not inlined here.
 */
export function buildSummary(date: string, papers: ReviewedPaper[], overview: string): string {
  const sorted = [...papers].sort((a, b) => b.review.score - a.review.score);
  const avg = sorted.length ? sorted.reduce((s, p) => s + p.review.score, 0) / sorted.length : 0;

  const lines: string[] = [];
  lines.push(`# arXiv 安全论文汇总 — ${fmtDate(date)}`, "");
  lines.push(`**共 ${sorted.length} 篇 | 平均分 ${avg.toFixed(1)}/10**`, "", "---", "");

  // LLM overall synthesis.
  lines.push("## 今日综述", "");
  lines.push(overview.trim() || "（综述生成失败）", "", "---", "");

  // Ranking table — ID links to the standalone per-paper review.
  lines.push("## 评分排序", "");
  lines.push("| # | 评分 | arXiv ID | 标题 | 类别 | 版本 |");
  lines.push("|---|------|----------|------|------|------|");
  sorted.forEach((p, i) => {
    const title = p.title.replace(/\|/g, "\\|");
    const ver = p.version > 1 ? `v${p.version}` : "首次";
    lines.push(
      `| ${i + 1} | ${p.review.score.toFixed(1)} | [${p.id}](reviews/${p.id}.md) | ${title} | ${p.category} | ${ver} |`,
    );
  });
  lines.push("", "---", "");

  // Category breakdown.
  lines.push("## 分类统计", "");
  lines.push("| 类别 | 数量 |", "|------|------|");
  const counts = new Map<string, number>();
  for (const p of sorted) counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
  [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([cat, n]) => lines.push(`| ${cat} | ${n} |`));
  lines.push("", "---", "");

  // Every paper's full review, in score order.
  lines.push("## 单篇评测", "");
  sorted.forEach((p, i) => {
    lines.push(`### ${i + 1}. [${p.review.score.toFixed(1)}] ${p.title}`);
    lines.push(`**arXiv: ${p.id}** | **类别: ${p.category}** | **来源: ${p.sourceNote}**`, "");
    lines.push(p.review.body.trim(), "");
  });
  lines.push(`> 各篇也单独存于 \`reviews/\` 目录。`);

  return lines.join("\n");
}

/**
 * Reconstruct a previously-written review from `reviews/{id}.md` (the inverse of
 * `writeReviewFile`), or null if it's absent / in an unrecognized format. Lets a
 * re-run skip the LLM (and the download) for papers already summarized.
 */
export async function readExistingReview(
  saveDir: string,
  id: string,
): Promise<{ review: Review; sourceNote: string } | null> {
  const file = Bun.file(join(saveDir, "reviews", `${id}.md`));
  if (!(await file.exists())) return null;
  const text = await file.text();
  const score = Number(text.match(/评分:\s*([0-9.]+)\s*\/\s*10/)?.[1]);
  if (!Number.isFinite(score)) return null; // unparseable → fall back to re-review
  const sourceNote = text.match(/来源:\s*([^*]+?)\s*\*\*/)?.[1]?.trim() ?? "已有总结";
  const metaIdx = text.indexOf("**arXiv:"); // body is everything after the metadata line
  const nl = metaIdx >= 0 ? text.indexOf("\n", metaIdx) : -1;
  const body = (nl >= 0 ? text.slice(nl + 1) : text).trim();
  return { review: { score, body }, sourceNote };
}

/** Write one paper's standalone review file (called as soon as its review lands). */
export async function writeReviewFile(saveDir: string, p: ReviewedPaper): Promise<void> {
  await Bun.write(
    join(saveDir, "reviews", `${p.id}.md`),
    `# ${p.title}\n\n**arXiv: ${p.id}** | **类别: ${p.category}** | **评分: ${p.review.score.toFixed(1)}/10** | **来源: ${p.sourceNote}**\n\n${p.review.body.trim()}\n`,
  );
}

/** Write the big aggregate summary.md (per-paper files are written separately). */
export async function writeSummary(date: string, saveDir: string, papers: ReviewedPaper[], overview: string): Promise<string> {
  const summaryPath = join(saveDir, "summary.md");
  await Bun.write(summaryPath, buildSummary(date, papers, overview));
  return summaryPath;
}
