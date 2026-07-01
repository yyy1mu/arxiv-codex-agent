// Download worker pool: fetch a fixed set of papers' e-prints through the shared
// rate gate, handing each one to review (the pipeline) as it lands.
//
// Discovery is no longer a fan-out task tree — RSS (rss.ts) yields the whole
// candidate list up front and the LLM filter narrows it, so all that's left here
// is "download these N papers, M at a time, sharing the 3s gate". M workers let
// a slow download not idle the channel: while one streams, another claims the
// next slot. Already-summarized papers skip the (gated) download entirely.
import { downloadSource, type MatchedPaper, type SourceKind } from "./arxiv.ts";
import { extractArchive } from "./extract.ts";
import type { RateGate } from "./gate.ts";

export interface DownloadPoolOptions {
  gate: RateGate;
  saveDir: string;
  workers: number; // pool size sharing the gate
  /** Locate an already-downloaded source for a paper, or null. */
  existingKind: (id: string) => Promise<SourceKind | null>;
  /** True if this paper already has a written summary — skip the download too. */
  alreadyReviewed: (id: string) => Promise<boolean>;
  /** Called when a paper's content is ready — hand off to review. */
  onDownloaded: (paper: MatchedPaper, kind: SourceKind, index: number) => void;
}

/** Download every paper in `papers` using a worker pool over the shared gate. */
export async function runDownloadPool(papers: MatchedPaper[], opts: DownloadPoolOptions): Promise<void> {
  let cursor = 0; // next paper to claim; cursor++ is atomic between awaits in JS

  const handleOne = async (paper: MatchedPaper, index: number) => {
    // Already summarized → skip the gated download; review step reuses the file.
    if (await opts.alreadyReviewed(paper.id)) {
      console.log(`  ↩️ [#${index}] ${paper.id} 已有总结，跳过下载+评测`);
      opts.onDownloaded(paper, "none", index);
      return;
    }
    let kind = await opts.existingKind(paper.id);
    if (kind) console.log(`  ↩️ [#${index}] 已存在 ${kind === "tex" ? "tar.gz" : "pdf"}，跳过下载`);
    else kind = await downloadSource(paper.id, opts.saveDir, opts.gate);
    if (kind === "tex") await extractArchive(paper.id, opts.saveDir);
    opts.onDownloaded(paper, kind, index); // → review pipeline
  };

  const worker = async () => {
    while (true) {
      const i = cursor++;
      const paper = papers[i];
      if (!paper) return; // queue drained
      try {
        await handleOne(paper, i + 1);
      } catch (e) {
        console.log(`  ❌ [#${i + 1}] ${paper.id} 下载失败: ${e}`);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, opts.workers) }, () => worker()));
}
