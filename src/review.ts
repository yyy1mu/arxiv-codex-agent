// Paper-summary + overview, both built on the Codex SDK.
//
// Per-paper: the Codex agent runs in a read-only sandbox rooted at the paper
// save directory and opens the paper files itself, then returns a structured
// review through outputSchema.
// Overview: a tool-less synthesis pass over all per-paper reviews.
//
// By default config.ts points CODEX_BASE_URL/CODEX_API_KEY at the local Codex
// endpoint.
import { SECURITY_DOMAINS } from "./config.ts"; // also: side effect sets CODEX_BASE_URL / API_KEY / model
import { Codex, type ThreadOptions } from "@openai/codex-sdk";
import type { MatchedPaper, Paper, SourceKind } from "./arxiv.ts";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";

export interface Review {
  score: number; // 0-10, one decimal
  body: string; // markdown review body (the bullet block)
}

export interface PaperBrief {
  id: string;
  title: string;
  category: string;
  score: number;
  body: string; // the per-paper review body
}

// Local Codex endpoint/model defaults are set in config.ts and remain
// overridable via env.
const SDK_MODEL = process.env.ARXIV_AGENT_SDK_MODEL ?? "deepseek-v4-flash-ascend";
const CODEX_BASE_URL = requireEnv("CODEX_BASE_URL");
const CODEX_API_KEY = requireEnv("CODEX_API_KEY");
// Total attempts per paper before giving up (retries on any Codex SDK error).
const REVIEW_MAX_ATTEMPTS = Number(process.env.ARXIV_AGENT_REVIEW_ATTEMPTS ?? 3);
const CODEX_HTTP_FALLBACK = process.env.ARXIV_CODEX_HTTP_FALLBACK !== "0";
const codex = new Codex({ baseUrl: CODEX_BASE_URL, apiKey: CODEX_API_KEY });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}. Copy .env.example to .env and fill it in.`);
  return value;
}

const REVIEW_SYSTEM = `你是一位资深的计算机安全研究员，为 arXiv 安全论文撰写中文评测。
在只读沙箱中阅读当前目录下的论文源码：先递归列出论文目录里的所有 .tex 文件，找到含 \\documentclass 的主 .tex 并优先阅读，但不能只读主文件；还要继续阅读主文件通过 \\input{}、\\include{}、\\subfile{} 引入的章节文件，以及其余与正文/附录/实验相关的 .tex 文件。重点关注 \\title、abstract、introduction、方法、实验、limitations、appendix、conclusion；若只有 PDF 则直接读 PDF。
读完后只输出一个 JSON 对象，字段如下（全部中文，定量结果优先，关键术语/数字可用 <b>…</b> 强调）：
- score：0-10 数字，保留一位小数（9.0+ 顶级且可复现；8.0-8.9 扎实有价值；7.0-7.9 合格但增量；<7.0 明显短板）
- core：核心问题，1-2 句
- method：方法，2-3 句
- findings：关键发现/实验，最重要的定量结果
- highlights：亮点，2-4 条字符串数组，每条一句
- limitations：不足，2-4 条字符串数组，每条一句
- verdict：总评，一句话结论（不要带 "X/10" 前缀）
直接输出 JSON，不要代码块包裹，不要多余解释。`;

// Structured review schema = score + the six card fields. The free-text body is
// assembled deterministically from these (assembleBody), so it always matches
// the template exactly instead of relying on the model to format markdown.
const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "number" },
    core: { type: "string" },
    method: { type: "string" },
    findings: { type: "string" },
    highlights: { type: "array", items: { type: "string" } },
    limitations: { type: "array", items: { type: "string" } },
    verdict: { type: "string" },
  },
  required: ["score", "core", "method", "findings", "highlights", "limitations", "verdict"],
  additionalProperties: false,
} as const;

interface RunCodexOptions {
  systemPrompt?: string;
  workingDirectory?: string;
  outputSchema?: unknown;
}

/** Run one Codex turn and normalize it to the old {raw, structured} shape. */
async function runCodex(prompt: string, options: RunCodexOptions = {}) {
  const threadOptions: ThreadOptions = {
    model: SDK_MODEL,
    sandboxMode: "read-only",
    approvalPolicy: "never",
    skipGitRepoCheck: true,
  };
  if (options.workingDirectory) threadOptions.workingDirectory = options.workingDirectory;

  const thread = codex.startThread(threadOptions);
  const fullPrompt = options.systemPrompt ? `${options.systemPrompt}\n\n用户任务：\n${prompt}` : prompt;
  let raw = "";
  try {
    const turn = await thread.run(fullPrompt, options.outputSchema ? { outputSchema: options.outputSchema } : undefined);
    raw = turn.finalResponse.trim();
  } catch (e) {
    if (!CODEX_HTTP_FALLBACK) throw e;
    raw = await runResponsesHttp(fullPrompt);
  }
  if (!raw) throw new Error("Codex SDK 未返回 finalResponse");
  return { result: raw, structured_output: parseJsonObject(raw) };
}

async function runResponsesHttp(input: string): Promise<string> {
  const url = `${CODEX_BASE_URL.replace(/\/$/, "")}/responses`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CODEX_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: SDK_MODEL, input }),
  });
  if (!res.ok) throw new Error(`Codex HTTP fallback 失败: ${res.status} ${await res.text()}`);
  const data: any = await res.json();
  const text =
    data.output_text ??
    data.output
      ?.flatMap((item: any) => item?.content ?? [])
      ?.filter((c: any) => c?.type === "output_text" || typeof c?.text === "string")
      ?.map((c: any) => c.text)
      ?.join("");
  if (typeof text !== "string" || !text.trim()) throw new Error("Codex HTTP fallback 未返回文本");
  return text.trim();
}

function parseJsonObject(raw: string): unknown {
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const direct = cleaned.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(direct);
  } catch {
    const m = direct.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

const header = (p: MatchedPaper) =>
  `arXiv ID: ${p.id}\n标题: ${p.title}\n分类标签: ${p.category}\n发布时间: ${p.published}\n\n摘要:\n${p.summary}\n`;

// ---- Relevance filter: cheap, tool-less LLM pass over one category's RSS ----

const FILTER_SYSTEM = `你是计算机安全方向的论文初筛助手。会给你某个 arXiv 分类当天 RSS 的一批论文（标题+摘要）。
任务：挑出与【计算机安全 / 攻防 / 漏洞 / 防护】真正相关、值得安全研究员深读的论文，其余一律过滤。
判定从严：纯机器学习、纯系统/网络性能优化、纯理论且与安全无明显关联的，不要选。
对每篇选中的论文，从下列领域标签里选一个最贴切的：
${SECURITY_DOMAINS.map((d) => `- ${d}`).join("\n")}

只输出一个 JSON 对象，形如：
{"interesting":[{"id":"2606.04017v1","domain":"Web Security"}]}
id 必须原样照抄输入里的 id（含版本号）；没有相关论文则 interesting 为空数组。
直接输出 JSON，不要用代码块包裹，不要任何多余解释。`;

/**
 * LLM relevance filter for ONE category's RSS entries. Returns the security-
 * relevant subset, each tagged with a domain label (→ `MatchedPaper`). Cheap:
 * tool-less, single turn. Never throws — on any failure it returns [].
 */
export async function filterInteresting(cat: string, papers: Paper[]): Promise<MatchedPaper[]> {
  if (papers.length === 0) return [];
  const list = papers
    .map((p, i) => `${i + 1}. id=${p.id}\n标题: ${p.title}\n摘要: ${p.summary.slice(0, 400)}`)
    .join("\n\n");
  try {
    const result = await runCodex(`arXiv 分类 ${cat}，共 ${papers.length} 篇，请初筛：\n\n${list}`, {
      systemPrompt: FILTER_SYSTEM,
    });
    const picked = parseFilter(result.structured_output, result.result);
    // Map ids back to the full paper; tolerate the model dropping the version.
    const byId = new Map<string, Paper>();
    for (const p of papers) {
      byId.set(p.id, p);
      byId.set(p.id.replace(/v\d+$/, ""), p);
    }
    const out: MatchedPaper[] = [];
    const seen = new Set<string>();
    for (const { id, domain } of picked) {
      const p = byId.get(id) ?? byId.get(id.replace(/v\d+$/, ""));
      if (p && !seen.has(p.id)) {
        seen.add(p.id);
        out.push({ ...p, category: SECURITY_DOMAINS.includes(domain) ? domain : cat });
      }
    }
    return out;
  } catch (e) {
    console.log(`  ⚠️ ${cat} 初筛失败，跳过该分类: ${String(e).slice(0, 120)}`);
    return [];
  }
}

function parseFilter(structured: unknown, raw: string): { id: string; domain: string }[] {
  const pick = (o: any): { id: string; domain: string }[] | null =>
    o && Array.isArray(o.interesting)
      ? o.interesting
          .filter((x: any) => x && typeof x.id === "string")
          .map((x: any) => ({ id: x.id.trim(), domain: String(x.domain ?? "").trim() }))
      : null;
  if (structured && typeof structured === "object") {
    const r = pick(structured);
    if (r) return r;
  }
  // Fallback: model returned JSON as plain text (DeepSeek often ignores schema).
  const m = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const r = pick(JSON.parse(m[0]));
      if (r) return r;
    } catch {
      /* not valid JSON → no picks */
    }
  }
  return [];
}

/** Run one review config with retries; throws only if every attempt fails. */
async function tryReview(prompt: string, options: RunCodexOptions, label: string): Promise<Review> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= REVIEW_MAX_ATTEMPTS; attempt++) {
    try {
      const result = await runCodex(prompt, options);
      return coerceReview(result.structured_output, result.result);
    } catch (e) {
      lastErr = e;
      if (attempt < REVIEW_MAX_ATTEMPTS) {
        console.log(`  ↻ ${label} 第 ${attempt}/${REVIEW_MAX_ATTEMPTS} 次出错，重试: ${String(e).slice(0, 120)}`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  }
  throw lastErr;
}

export async function reviewPaper(paper: MatchedPaper, saveDir: string, sourceKind: SourceKind): Promise<Review> {
  // Phase 1: full review reading the source files (with retries).
  if (sourceKind !== "none") {
    const where =
      sourceKind === "tex"
        ? `论文 LaTeX 源码在 ./${paper.id}/ 目录下。请先递归列出所有 .tex 文件，找到含 \\documentclass 的主 .tex 并优先阅读；随后继续阅读主文件通过 \\input{}、\\include{}、\\subfile{} 引入的章节文件，以及其余与正文/附录/实验相关的 .tex 文件。不要只读主 .tex 后就下结论。`
        : `论文 PDF 在 ./${paper.id}.pdf，请用 Read 直接阅读它。`;
    const context = await readPaperContext(paper.id, saveDir, sourceKind);
    try {
      return await tryReview(`请评测以下 arXiv 安全论文。\n${header(paper)}\n${where}${context}`, {
        workingDirectory: saveDir,
        systemPrompt: REVIEW_SYSTEM,
        outputSchema: REVIEW_SCHEMA,
      }, `[${paper.id}] 读全文`);
    } catch (e) {
      console.log(`  ⚠️ [${paper.id}] 读全文评测重试用尽，降级为仅摘要评测: ${String(e).slice(0, 120)}`);
    }
  }

  // Phase 2 (fallback / no-source): metadata-only, no filesystem access, so
  // this all but guarantees the paper still gets a review.
  const review = await tryReview(
    `请评测以下 arXiv 安全论文（正文不可用，仅依据标题与摘要评测，并在"不足"中注明未读全文）。\n${header(paper)}`,
    { systemPrompt: REVIEW_SYSTEM, outputSchema: REVIEW_SCHEMA },
    `[${paper.id}] 降级`,
  );
  if (sourceKind !== "none") review.body = `> ⚠️ 未能读取全文，以下仅基于标题与摘要。\n\n${review.body}`;
  return review;
}

async function readPaperContext(id: string, saveDir: string, sourceKind: SourceKind): Promise<string> {
  if (sourceKind !== "tex") return "";
  const root = join(saveDir, id);
  const files = await listTextFiles(root).catch(() => []);
  if (files.length === 0) return "";

  let remaining = 120_000;
  const chunks: string[] = [];
  for (const file of files) {
    if (remaining <= 0) break;
    const text = await readFile(file, "utf8").catch(() => "");
    if (!text) continue;
    const slice = text.slice(0, remaining);
    chunks.push(`\n\n--- ${file.replace(`${root}/`, "")} ---\n${slice}`);
    remaining -= slice.length;
  }
  return chunks.length > 0 ? `\n\n以下是本地抽取的 LaTeX/文本内容，供无法使用 Codex 文件工具时直接评测：${chunks.join("")}` : "";
}

async function listTextFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (![".git", "node_modules", "__MACOSX"].includes(entry.name)) await walk(path);
      } else if (isPaperTextFile(path)) {
        const s = await stat(path);
        if (s.size <= 2_000_000) out.push(path);
      }
    }
  };
  await walk(root);
  return out.sort((a, b) => scorePaperFile(a) - scorePaperFile(b)).slice(0, 24);
}

function isPaperTextFile(path: string): boolean {
  return [".tex", ".bib", ".bbl", ".txt", ".md"].includes(extname(path).toLowerCase());
}

function scorePaperFile(path: string): number {
  const name = path.toLowerCase();
  if (name.endsWith(".tex") && /main|paper|article|manuscript/.test(name)) return 0;
  if (name.endsWith(".tex")) return 1;
  if (name.endsWith(".bbl") || name.endsWith(".bib")) return 3;
  return 4;
}

const OVERVIEW_SYSTEM = `你是安全领域的资深编辑。你会拿到当天多篇 arXiv 安全论文的"单篇评测"，
需要把它们提炼、串联成一篇高质量的中文整体综述。不要逐篇复述（逐篇评测会另附在汇总里），
聚焦归纳趋势、点出关联、给出判断。直接输出 markdown 正文，不要代码块包裹。`;

export async function synthesizeOverview(date: string, briefs: PaperBrief[]): Promise<string> {
  const list = briefs
    .map((b, i) => `${i + 1}. [${b.score.toFixed(1)}] (${b.category}) ${b.title} — arXiv:${b.id}\n${b.body}`)
    .join("\n\n");

  const prompt =
    `以下是 ${date} 当天 ${briefs.length} 篇 arXiv 安全论文的单篇评测。请写一篇整体综述，包含：\n` +
    `- **今日概览**：1-2 句话概括当天安全研究的整体动向与数量/质量分布\n` +
    `- **热点方向**：归纳 2-4 个值得关注的主题趋势，每条 1-2 句并点名相关论文（标题简称 + arXiv ID）\n` +
    `- **重点推荐**：挑 3-5 篇最值得深读的，逐条一句话说明理由\n` +
    `- **一句话总评**：对当天整体的判断\n\n单篇评测如下：\n\n${list}`;

  const result = await runCodex(prompt, {
    systemPrompt: OVERVIEW_SYSTEM,
  });
  return result.result.replace(/^```(?:markdown)?/i, "").replace(/```$/, "").trim();
}

// ---- Card data: turn a review into structured fields for the HTML card ----

export interface CardData {
  core: string; // 核心问题
  method: string; // 方法
  findings: string; // 关键发现/实验
  highlights: string[]; // 亮点 (2-4 points)
  limitations: string[]; // 不足 (2-4 points)
  verdict: string; // 总评 (one-liner, no score prefix)
}

const CARD_SYSTEM = `你是把论文中文评测整理成"卡片"展示数据的助手。会给你一篇论文的评测正文
（含 核心问题/方法/关键发现/亮点/不足/总评）。整理成结构化字段：
- core/method/findings/verdict：各 1-3 句，简洁通顺；可用 <b>…</b> 强调关键术语或数字。
- highlights(亮点)/limitations(不足)：拆成 2-4 条独立要点的字符串数组，每条一句、去掉"1)2)"之类前缀，可用 <b>…</b>。
- verdict(总评)：只保留那句结论，不要带"X/10"评分前缀。
只输出一个 JSON 对象：{"core","method","findings","highlights":[],"limitations":[],"verdict"}。
直接输出 JSON，不要代码块包裹，不要多余解释。`;

const CARD_SCHEMA = {
  type: "object",
  properties: {
    core: { type: "string" },
    method: { type: "string" },
    findings: { type: "string" },
    highlights: { type: "array", items: { type: "string" } },
    limitations: { type: "array", items: { type: "string" } },
    verdict: { type: "string" },
  },
  required: ["core", "method", "findings", "highlights", "limitations", "verdict"],
  additionalProperties: false,
} as const;

/** Turn a review into card fields via the SDK (with retries); falls back to
 *  local parsing if every Codex attempt fails. */
export async function extractCardData(review: Review): Promise<CardData> {
  for (let attempt = 1; attempt <= REVIEW_MAX_ATTEMPTS; attempt++) {
    try {
      const result = await runCodex(`请把下面的论文评测整理成卡片字段：\n\n${review.body}`, {
        systemPrompt: CARD_SYSTEM,
        outputSchema: CARD_SCHEMA,
      });
      const d = parseCard(result.structured_output, result.result);
      if (d) return d;
      throw new Error("卡片字段解析为空");
    } catch (e) {
      if (attempt < REVIEW_MAX_ATTEMPTS) {
        console.log(`  ↻ 卡片字段第 ${attempt}/${REVIEW_MAX_ATTEMPTS} 次出错，重试: ${String(e).slice(0, 100)}`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      } else {
        console.log(`  ⚠️ 卡片字段生成重试用尽，回退本地解析: ${String(e).slice(0, 100)}`);
      }
    }
  }
  return parseReviewBody(review.body);
}

function parseCard(structured: unknown, raw: string): CardData | null {
  const pick = (o: any): CardData | null =>
    o && typeof o === "object" && typeof o.core === "string"
      ? {
          core: String(o.core ?? ""),
          method: String(o.method ?? ""),
          findings: String(o.findings ?? ""),
          highlights: Array.isArray(o.highlights) ? o.highlights.map(String).filter(Boolean) : [],
          limitations: Array.isArray(o.limitations) ? o.limitations.map(String).filter(Boolean) : [],
          verdict: String(o.verdict ?? ""),
        }
      : null;
  if (structured) {
    const d = pick(structured);
    if (d) return d;
  }
  const m = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return pick(JSON.parse(m[0]));
    } catch {
      /* not valid JSON */
    }
  }
  return null;
}

/** Deterministic fallback: pull the six sections straight out of the markdown. */
function parseReviewBody(body: string): CardData {
  const sec = (label: string) =>
    body.match(new RegExp(`\\*\\*${label}[^*]*\\*\\*[:：]?\\s*([\\s\\S]*?)(?=\\n\\s*-\\s*\\*\\*|$)`))?.[1]?.trim() ?? "";
  const toItems = (text: string): string[] => {
    const byNum = text.split(/\s*[\d①-⑨]+\s*[)）.、:：]\s*/).map((s) => s.trim()).filter(Boolean);
    if (byNum.length >= 2) return byNum;
    const bySemi = text.split(/[；;]\s*/).map((s) => s.trim()).filter(Boolean);
    if (bySemi.length >= 2) return bySemi;
    return text ? [text] : [];
  };
  const verdict = sec("总评");
  return {
    core: sec("核心问题"),
    method: sec("方法"),
    findings: sec("关键发现"),
    highlights: toItems(sec("亮点")),
    limitations: toItems(sec("不足")),
    verdict: verdict.replace(/^\s*\d+(?:\.\d+)?\s*\/\s*10\s*[。.]?\s*/, "").trim() || verdict,
  };
}

function coerceReview(structured: unknown, fallback: string): Review {
  const cleaned = fallback.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const score = sniffScore(structured, cleaned);
  // Prefer the structured fields; if the model returned markdown instead of
  // JSON, recover the six sections from it. Either way → strict assembled body.
  const card = parseCard(structured, cleaned) ?? fromMarkdown(cleaned);
  if (card && card.core) return { score, body: assembleBody(card, score) };
  return { score, body: cleaned || "（评测解析失败）" };
}

function sniffScore(structured: unknown, raw: string): number {
  const s = (structured as any)?.score;
  if (Number.isFinite(Number(s))) return clampScore(Number(s));
  const m = raw.match(/"score"\s*:\s*([\d.]+)/) ?? raw.match(/(\d{1,2}(?:\.\d)?)\s*\/\s*10/);
  return m ? clampScore(Number(m[1])) : 0;
}

/** Build the strict template-format markdown body from the six fields. */
function assembleBody(d: CardData, score: number): string {
  const items = (arr: string[]) => arr.map((s, i) => `  ${i + 1}. ${s}`).join("\n");
  return [
    `- **核心问题**: ${d.core}`,
    `- **方法**: ${d.method}`,
    `- **关键发现/实验**: ${d.findings}`,
    `- **亮点**:\n${items(d.highlights)}`,
    `- **不足**:\n${items(d.limitations)}`,
    `- **总评**: ${score.toFixed(1)}/10。${d.verdict}`,
  ].join("\n");
}

/** Last-resort: recover card fields from a markdown body (model ignored schema). */
function fromMarkdown(text: string): CardData | null {
  const d = parseReviewBody(text);
  return d.core || d.method ? d : null;
}

function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.max(0, Math.min(10, n)) * 10) / 10;
}
