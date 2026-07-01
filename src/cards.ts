// Top-N paper "summary cards": review → structured fields (Agent SDK) → fill
// the HTML template's `paper` object → render to PNG with the local Chrome.
import puppeteer, { type Browser } from "puppeteer-core";
import { readFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractCardData, type CardData } from "./review.ts";
import type { ReviewedPaper } from "./summary.ts";

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEFAULT_CARD_TEMPLATE = fileURLToPath(new URL("../论文卡片模板.html", import.meta.url));
const CARD_TEMPLATE = process.env.CARD_TEMPLATE ?? DEFAULT_CARD_TEMPLATE;

/** Splice the card's data into the template's `const paper = {...}` block. */
function buildCardHtml(template: string, p: ReviewedPaper, d: CardData): string {
  const [src, status] = p.sourceNote.split(" · ");
  const paperObj = {
    kicker: "Paper Summary",
    title: p.title,
    meta: [
      { label: "arXiv", value: p.id },
      { label: "类别", value: p.category },
      { label: "来源", value: src ?? p.sourceNote },
      { label: "状态", value: status ?? (p.version > 1 ? `v${p.version} 更新` : "首次提交") },
      { label: "评分", value: `${p.review.score.toFixed(1)}/10` },
    ],
    sections: [
      { idx: "01", title: "核心问题", body: d.core },
      { idx: "02", title: "方法", body: d.method },
      { idx: "03", title: "关键发现 / 实验", body: d.findings },
      { idx: "04", title: "亮点", items: d.highlights },
      { idx: "05", title: "不足", items: d.limitations },
      { tone: "verdict", title: "总评", body: d.verdict },
    ],
    footer: `arXiv ${p.id} · ${p.category} · Paper Summary Card`,
  };
  const head = template.slice(0, template.indexOf("const paper ="));
  const tail = template.slice(template.indexOf("/* ---------- 渲染"));
  return `${head}const paper = ${JSON.stringify(paperObj, null, 2)};\n\n${tail}`;
}

/** Screenshot the `.stage` element (auto-fits card height) to a PNG. */
async function renderPng(browser: Browser, htmlPath: string, pngPath: string): Promise<void> {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1200, height: 900, deviceScaleFactor: 2 });
    await page.goto(`file://${htmlPath}`, { waitUntil: "load", timeout: 20_000 });
    await new Promise((r) => setTimeout(r, 800)); // let web fonts settle
    const el = await page.$(".stage");
    if (!el) throw new Error(".stage element not found");
    await el.screenshot({ path: pngPath });
  } finally {
    await page.close();
  }
}

/**
 * Generate a summary card (HTML + PNG) for each given paper. Skips any whose PNG
 * already exists. Writes to `<saveDir>/cards/{id}.{html,png}`. Reuses one Chrome.
 */
export async function generateCards(saveDir: string, papers: ReviewedPaper[]): Promise<void> {
  const cardsDir = join(saveDir, "cards");
  await mkdir(cardsDir, { recursive: true });

  const todo: ReviewedPaper[] = [];
  for (const p of papers) {
    if (await Bun.file(join(cardsDir, `${p.id}.png`)).exists()) {
      console.log(`  ↩️ 卡片已存在，跳过 ${p.id}`);
    } else {
      todo.push(p);
    }
  }
  if (todo.length === 0) {
    console.log("  (全部卡片已存在)");
    return;
  }

  let template: string;
  try {
    template = await readFile(CARD_TEMPLATE, "utf8");
  } catch (e) {
    console.log(`  ❌ 读取卡片模板失败 (${CARD_TEMPLATE}): ${e}`);
    return;
  }

  let browser: Browser;
  try {
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
  } catch (e) {
    console.log(`  ❌ 启动 Chrome 失败 (${CHROME}): ${e}`);
    return;
  }

  try {
    for (const p of todo) {
      try {
        const data = await extractCardData(p.review);
        const htmlPath = join(cardsDir, `${p.id}.html`);
        await Bun.write(htmlPath, buildCardHtml(template, p, data));
        await renderPng(browser, htmlPath, join(cardsDir, `${p.id}.png`));
        console.log(`  🖼️ [${p.review.score.toFixed(1)}] ${p.id} → cards/${p.id}.png`);
      } catch (e) {
        console.log(`  ❌ 卡片失败 ${p.id}: ${String(e).slice(0, 150)}`);
      }
    }
  } finally {
    await browser.close();
  }
}
