import express from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { PDFParse } from "pdf-parse";
import { chromium } from "playwright";
import { PDFDocument } from "pdf-lib";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const uploadDir = path.join(__dirname, "uploads");
const evidenceDir = path.join(__dirname, "evidence");
const reportsDir = path.join(__dirname, "reports");

await fs.mkdir(uploadDir, { recursive: true });
await fs.mkdir(evidenceDir, { recursive: true });
await fs.mkdir(reportsDir, { recursive: true });

await sweepOldFiles();

const app = express();
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 30 * 1024 * 1024 }
});

app.use(express.json({ limit: "2mb" }));
app.use("/evidence", express.static(evidenceDir));
app.use("/reports", express.static(reportsDir));

if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.join(rootDir, "dist")));
}

app.post("/api/analyze", upload.any(), async (req, res) => {
  try {
    const files = (req.files || []).filter((file) => file.fieldname === "pdfs");
    if (!files.length) {
      return res.status(400).json({ error: "PDF dosyasi yuklenmedi." });
    }

    const items = [];
    const failures = [];
    for (const file of files) {
      try {
        items.push(await analyzePdfFile(file));
      } catch (error) {
        console.error(`PDF analiz hatasi (${file.originalname}):`, error.message);
        failures.push({ fileName: file.originalname, error: error.message });
      }
    }

    if (!items.length) {
      const detail = failures.map((f) => `${f.fileName}: ${f.error}`).join(" | ");
      return res.status(500).json({ error: `Hicbir PDF islenemedi. ${detail}` });
    }

    res.json({
      fileName: items[0]?.fileName || "",
      textPreview: items[0]?.textPreview || "",
      metadata: items[0]?.metadata || {},
      items,
      failures
    });
  } catch (error) {
    console.error("/api/analyze fatal:", error);
    res.status(500).json({ error: error.message || "Bilinmeyen hata." });
  }
});

app.post("/api/verify", async (req, res) => {
  try {
    const metadata = (req.body && typeof req.body === "object" ? req.body.metadata : null) || {};
    const result = await verifyEvidence(metadata);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message, requiresManualUrl: true });
  }
});

app.post("/api/capture", async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url || !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ error: "Gecerli bir kanit URL'si girin." });
    }

    const capture = await captureEvidencePage(url);
    res.json(capture);
  } catch (error) {
    res.status(500).json({
      error: `${error.message}. Chromium kurulu degilse: npx playwright install chromium`
    });
  }
});

app.post("/api/report", async (req, res) => {
  try {
    const { metadata, verification, capture } = req.body || {};
    const baseHref = `${req.protocol}://${req.get("host")}`;
    const html = renderReportDocument({ items: [{ metadata, verification, capture }], baseHref });
    const reportName = `rapor-son-sayfa-${crypto.randomUUID()}.html`;
    const reportPath = path.join(reportsDir, reportName);
    await fs.writeFile(reportPath, html, "utf8");

    res.json({
      html,
      reportUrl: `/reports/${reportName}`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/export-pdf", async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) {
      return res.status(400).json({ error: "Dışa aktarılacak kayıt bulunamadı." });
    }

    const internalBaseHref = `http://127.0.0.1:${port}`;
    const outputPdf = await PDFDocument.create();
    for (const item of items) {
      if (!item.uploadId) continue;
      const originalPath = path.join(uploadDir, path.basename(item.uploadId));
      const originalBytes = await fs.readFile(originalPath);
      const originalPdf = await PDFDocument.load(originalBytes, { ignoreEncryption: true });
      const originalPages = await outputPdf.copyPages(originalPdf, originalPdf.getPageIndices());
      originalPages.forEach((page) => outputPdf.addPage(page));

      const appendixHtml = renderReportDocument({ items: [item], baseHref: internalBaseHref });
      const appendixBytes = await renderHtmlToPdf(appendixHtml);
      const appendixPdf = await PDFDocument.load(appendixBytes);
      const appendixPages = await outputPdf.copyPages(appendixPdf, appendixPdf.getPageIndices());
      appendixPages.forEach((page) => outputPdf.addPage(page));
    }

    if (!outputPdf.getPageCount()) {
      return res.status(400).json({ error: "Orijinal PDF kaydı bulunamadı." });
    }

    const outputBytes = await outputPdf.save();
    const pdfName = `dizin-kanit-ekli-${crypto.randomUUID()}.pdf`;
    const pdfPath = path.join(reportsDir, pdfName);
    await fs.writeFile(pdfPath, outputBytes);

    res.json({
      pdfUrl: `/reports/${pdfName}`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

if (process.env.NODE_ENV === "production") {
  app.use((req, res, next) => {
    if (req.method !== "GET") return next();
    if (req.path.startsWith("/api/") || req.path.startsWith("/evidence/") || req.path.startsWith("/reports/")) return next();
    res.sendFile(path.join(rootDir, "dist", "index.html"));
  });
}

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
const server = app.listen(port, host, () => {
  console.log(`API hazir: http://${host}:${port}`);
});

server.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});

async function sweepOldFiles() {
  const ttl = 24 * 3600 * 1000;
  const now = Date.now();
  for (const dir of [uploadDir, evidenceDir, reportsDir]) {
    try {
      const entries = await fs.readdir(dir);
      for (const entry of entries) {
        const filePath = path.join(dir, entry);
        try {
          const stat = await fs.stat(filePath);
          if (now - stat.mtimeMs > ttl) {
            await fs.unlink(filePath);
          }
        } catch {}
      }
    } catch {}
  }
}

async function extractPdfText(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const parsed = await parser.getText();
    return parsed.text || "";
  } finally {
    await parser.destroy?.();
  }
}

async function analyzePdfFile(file) {
  const buffer = await fs.readFile(file.path);
  const text = await extractPdfText(buffer);
  const metadata = extractMetadata(text, file.originalname);

  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    uploadId: file.filename,
    fileName: file.originalname,
    textPreview: cleanText(text).slice(0, 2000),
    metadata
  };
}

function extractMetadata(rawText, fileName) {
  const text = cleanText(rawText);
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const doi = firstMatch(text, /(10\.\d{4,9}\/[^\s"'<>]+)/i);
  const cleanDoi = doi ? doi.replace(/[.,;)]+$/g, "") : "";
  const year = firstMatch(text, /\b(20\d{2}|19\d{2})\b/);
  const volumeIssuePages = extractVolumeIssuePages(text);
  const journal = extractJournal(text);
  const title = extractTitle(lines, text);
  const authors = extractAuthors(lines, text);

  return {
    fileName,
    title,
    authors,
    journal,
    year: volumeIssuePages.year || year || "",
    volume: volumeIssuePages.volume || "",
    issue: volumeIssuePages.issue || "",
    pages: volumeIssuePages.pages || "",
    doi: cleanDoi,
    sourceConfidence: {
      title: title ? "auto" : "missing",
      journal: journal ? "auto" : "missing",
      doi: cleanDoi ? "auto" : "missing"
    }
  };
}

function cleanText(value) {
  return String(value || "")
    .replace(/\r/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function firstMatch(text, regex) {
  const match = text.match(regex);
  return match ? match[1] : "";
}

function extractVolumeIssuePages(text) {
  const patterns = [
    /\b(20\d{2}|19\d{2})\s*,\s*(\d+)\s*\(([^)]+)\)\s*,\s*(\d+\s*[-–]\s*\d+)/,
    /Vol\.\s*(\d+)\s*\/\s*No\.\s*([0-9]+)\s*\/\s*(20\d{2}|19\d{2})\s*,\s*pp\.\s*(\d+\s*[-–]\s*\d+)/i
  ];

  const first = text.match(patterns[0]);
  if (first) {
    return {
      year: first[1],
      volume: first[2],
      issue: first[3],
      pages: first[4].replace(/\s/g, "")
    };
  }

  const second = text.match(patterns[1]);
  if (second) {
    return {
      year: second[3],
      volume: second[1],
      issue: second[2],
      pages: second[4].replace(/\s/g, "")
    };
  }

  return {};
}

function extractJournal(text) {
  const citationJournal = text.match(/\)\.\s+.+?\.\s+([^.\n]+?Dergisi),\s+\d+\s*\(/s);
  if (citationJournal) return citationJournal[1].trim();

  const englishCitation = text.match(/,\s+([^,\n]+),\s+\d+\s*\(\d+\),\s+\d+\s*[-–]\s*\d+/);
  if (englishCitation) return englishCitation[1].trim();

  return "";
}

function extractTitle(lines, text) {
  const citationTitle = text.match(/\(\d{4}\)\.\s+[“"]?(.+?)[”"]?\s+[A-ZÇĞİÖŞÜÂ][^.]+?(?:Dergisi|Journal|Review|Studies|Quarterly)/s);
  if (citationTitle) {
    return oneLine(citationTitle[1]).replace(/[."]+$/g, "");
  }

  const startIndex = lines.findIndex((line) => /Araştırma Makalesi|Research Article/i.test(line));
  if (startIndex >= 0) {
    const collected = [];
    for (const line of lines.slice(startIndex + 1, startIndex + 5)) {
      if (/^Öz$|^Abstract$|^\*|^\d+$/.test(line)) break;
      if (collected.length > 0 && looksLikeAuthorLine(line)) break;
      collected.push(line);
    }
    if (collected.length) return oneLine(collected.join(" "));
  }

  return "";
}

function extractAuthors(lines, text) {
  const trCitation = text.match(/^([A-ZÇĞİÖŞÜÂ][A-ZÇĞİÖŞÜÂa-zçğıöşüâ.,\s;&-]+?)\s+\(\d{4}\)\./m);
  if (trCitation) return normalizeAuthorList(trCitation[1]);

  const citationAuthor = text.match(/^([A-ZÇĞİÖŞÜ][A-ZÇĞİÖŞÜa-zçğıöşü.,\s]+?)\s+\(\d{4}\)/m);
  if (citationAuthor) return oneLine(citationAuthor[1]);

  return "";
}

function looksLikeAuthorLine(line) {
  const cleaned = line.replace(/\d+|\*|ORCID:.*/gi, "").trim();
  if (!cleaned || cleaned.length > 140) return false;
  if (/[.:,]{2,}/.test(cleaned)) return false;
  return /^[\p{Lu}ÂÇĞİÖŞÜ][\p{L}ÂÇĞİÖŞÜçğıöşüâ.'\-\s;,&]+$/u.test(cleaned) && cleaned.split(/\s+/).length <= 12;
}

function normalizeAuthorList(value) {
  return oneLine(value)
    .replace(/\d+/g, "")
    .replace(/\*/g, "")
    .replace(/\s+and\s+/gi, "; ")
    .replace(/\s*&\s*/g, "; ")
    .replace(/\s+ve\s+/gi, "; ")
    .replace(/\s*;\s*/g, "; ")
    .replace(/\s*,\s*(?=[A-ZÇĞİÖŞÜÂ][a-zçğıöşüâ])/g, "; ")
    .replace(/;+$/g, "")
    .trim();
}

function oneLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

async function verifyEvidence(metadata) {
  const normalized = normalizeMetadata(metadata);
  const warnings = [];
  const sources = [];

  let publication = null;
  if (normalized.doi) {
    publication = await findTrDizinPublicationByDoi(normalized.doi);
    if (publication) {
      sources.push({
        label: "TR Dizin yayın kaydı",
        status: "bulundu",
        url: publication.url,
        details: "DOI ile yayın kaydı eşleşti."
      });
    }
  }

  let journal = null;
  if (publication?.source?.journal?.id) {
    journal = await getTrDizinJournalById(publication.source.journal.id);
  }

  if (!journal && normalized.journal) {
    journal = await findTrDizinJournalByName(normalized.journal);
  }

  if (journal) {
    const coverage = getJournalCoverage(journal.source, normalized.year);
    sources.push({
      label: "TR Dizin dergi kaydı",
      status: "bulundu",
      url: `https://search.trdizin.gov.tr/tr/dergi/detay/${journal.source.id}`,
      details: coverage.message
    });
    if (coverage.warning) warnings.push(coverage.warning);
  }

  const journalWebEvidence = publication ? null : await findJournalIndexPage(journal?.source, normalized.journal);
  if (journalWebEvidence) {
    sources.push({
      label: "Dergi dizin sayfası",
      status: "bulundu",
      url: journalWebEvidence.url,
      details: journalWebEvidence.details
    });
  }

  const evidenceUrl = publication?.url || journalWebEvidence?.url || (journal ? `https://search.trdizin.gov.tr/tr/dergi/detay/${journal.source.id}` : "");
  const indexName = publication ? "TR Dizin" : inferIndexName(journalWebEvidence, journal);

  let status;
  let requiresManualUrl;
  let message;
  if (publication?.url) {
    status = "found";
    requiresManualUrl = false;
    message = "Yayın için kanıt sayfası bulundu.";
  } else if (journalWebEvidence?.url) {
    status = "found";
    requiresManualUrl = false;
    message = "Dergi dizin sayfası bulundu.";
  } else if (evidenceUrl) {
    status = "journal_only";
    requiresManualUrl = true;
    message = "Yalnızca dergi detay sayfası bulundu. Yayına özel kanıt için manuel URL girebilirsiniz.";
  } else {
    status = "manual_required";
    requiresManualUrl = true;
    message = "Otomatik kanıt sayfası bulunamadı. Manuel kanıt URL'si girin; ekran görüntüsü sistem tarafından alınacak.";
  }

  return {
    status,
    requiresManualUrl,
    evidenceUrl,
    indexName,
    publication,
    journal,
    sources,
    warnings,
    message
  };
}

function normalizeMetadata(metadata) {
  return {
    title: oneLine(metadata.title),
    authors: oneLine(metadata.authors),
    journal: oneLine(metadata.journal),
    year: String(metadata.year || "").trim(),
    volume: String(metadata.volume || "").trim(),
    issue: String(metadata.issue || "").trim(),
    pages: String(metadata.pages || "").trim(),
    doi: String(metadata.doi || "").trim().replace(/^https?:\/\/doi\.org\//i, "")
  };
}

async function findTrDizinPublicationByDoi(doi) {
  const url = `https://search.trdizin.gov.tr/api/defaultSearch/publication/?q=${encodeURIComponent(doi)}&order=relevance-DESC&page=1`;
  const json = await fetchJson(url);
  const hits = json?.hits?.hits || [];
  const exact = hits.find((hit) => normalizeDoi(hit._source?.doi) === normalizeDoi(doi));
  if (!exact) return null;

  const source = exact._source;
  return {
    id: source.id,
    url: json.trdizinAddress || `https://search.trdizin.gov.tr/tr/yayin/detay/${source.id}`,
    source,
    title: source.abstracts?.[0]?.title || source.orderTitle || "",
    authors: extractPublicationAuthors(source),
    journal: source.journal?.name || "",
    year: String(source.publicationYear || ""),
    volume: source.issue?.volume || "",
    issue: source.issue?.number || "",
    pages: source.startPage && source.endPage ? `${source.startPage}-${source.endPage}` : "",
    doi: source.doi || doi,
    databases: source.databases || []
  };
}

function extractPublicationAuthors(source) {
  return (source?.authors || [])
    .sort((left, right) => (left.order || 0) - (right.order || 0))
    .map((author) => author.inPublicationName || author.name)
    .filter(Boolean)
    .join("; ");
}

async function getTrDizinJournalById(id) {
  const json = await fetchJson(`https://search.trdizin.gov.tr/api/journalById/${id}`);
  const hit = json?.hits?.hits?.[0];
  return hit ? { id: hit._source.id, source: hit._source } : null;
}

async function findTrDizinJournalByName(journalName) {
  const url = `https://search.trdizin.gov.tr/api/defaultSearch/journal/?q=${encodeURIComponent(journalName)}&order=relevance-DESC&page=1`;
  const json = await fetchJson(url);
  const hits = json?.hits?.hits || [];
  const wanted = normalizeName(journalName);
  const hit =
    hits.find((item) => normalizeName(item._source?.title) === wanted) ||
    hits.find((item) => normalizeName(item._source?.title).includes(wanted) || wanted.includes(normalizeName(item._source?.title))) ||
    hits[0];

  return hit ? { id: hit._source.id, source: hit._source } : null;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "accept": "application/json,text/plain,*/*",
        "user-agent": "DergiDizinKanitSistemi/0.1"
      }
    });
    if (!response.ok) throw new Error(`${url} yanit vermedi: ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeDoi(value) {
  return String(value || "").trim().toLowerCase().replace(/[.,;)]+$/g, "");
}

function normalizeName(value) {
  return String(value || "")
    .toLocaleLowerCase("tr")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getJournalCoverage(journal, year) {
  const databaseMap = {
    SOCIAL: "TR Dizin (Sosyal)",
    LIFE: "TR Dizin (Yaşam)",
    SCIENCE: "TR Dizin (Fen)",
    HEALTH: "TR Dizin (Sağlık)",
    ENG: "TR Dizin (Mühendislik)"
  };
  const codes = journal?.journalDatabase || [];
  const mapped = codes.map((code) => databaseMap[code] || code).filter(Boolean);
  const database = mapped.length ? mapped.join(", ") : "Dizin bilgisi";
  const matchingYear = journal?.journalYear?.find((item) => String(item.year) === String(year));
  const rejected = journal?.rejectYearList?.find((item) => String(item.year) === String(year));

  if (rejected) {
    return {
      message: `${database}; ${year} yılı kayıtta ret listesinde görünüyor.`,
      warning: `${year} yılı TR Dizin dergi kaydında ret listesinde görünüyor.`
    };
  }

  if (matchingYear) {
    return {
      message: `${database}; ${year} yılı dergi kaydında mevcut.`,
      warning: ""
    };
  }

  return {
    message: `${database}; yayın yılı için ayrı kontrol önerilir.`,
    warning: year ? `${year} yılı dergi kapsamında otomatik olarak eşleştirilemedi.` : ""
  };
}

async function findJournalIndexPage(journal, journalName) {
  const candidates = [];

  if (journal?.webAddress) {
    const base = normalizeBaseUrl(journal.webAddress);
    candidates.push(
      `${base}/pages/abstracting-and-indexing`,
      `${base}/abstracting-and-indexing`,
      `${base}/indexing-and-abstracting`,
      `${base}/indexing`,
      `${base}/abstracting-indexing`,
      `${base}/tarandigi-dizinler`,
      `${base}/dizinler`
    );
  }

  for (const url of [...new Set(candidates)]) {
    const page = await probeIndexPage(url);
    if (page) return page;
  }

  return null;
}

function normalizeBaseUrl(value) {
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  const parsed = new URL(withProtocol);
  return `${parsed.protocol}//${parsed.host}`.replace(/\/$/, "");
}

async function probeIndexPage(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "DergiDizinKanitSistemi/0.1" }
    });
    clearTimeout(timeout);
    if (!response.ok) return null;
    const html = await response.text();
    const lower = html.toLowerCase();
    const hasIndexSignal = /(abstracting|indexing|scopus|web of science|esci|ulakbim|tr dizin|dizin)/i.test(lower);
    if (!hasIndexSignal) return null;
    return {
      url,
      details: extractIndexTerms(html).join(", ") || "Dizin sayfası bulundu."
    };
  } catch {
    return null;
  }
}

function extractIndexTerms(html) {
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const terms = [
    ["Emerging Sources Citation Index", /Emerging Sources Citation Index|ESCI/i],
    ["Scopus", /Scopus/i],
    ["TR Dizin", /TR\s*Dizin/i],
    ["ULAKBİM", /ULAKB[İI]M/i],
    ["Web of Science", /Web of Science/i]
  ];
  return terms.filter(([, regex]) => regex.test(text)).map(([label]) => label);
}

function inferIndexName(pageEvidence, journal) {
  const detail = pageEvidence?.details || "";
  if (detail && detail !== "Dizin sayfası bulundu.") return detail;
  if (/TR Dizin/i.test(detail) || journal?.source?.journalDatabase?.length) return "TR Dizin";
  if (/Scopus/i.test(detail)) return "Scopus";
  if (/ESCI|Emerging/i.test(detail)) return "ESCI";
  return "Dizin kaydı";
}

async function captureEvidencePage(url) {
  const fileName = `kanit-${crypto.randomUUID()}.png`;
  const filePath = path.join(evidenceDir, fileName);
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 1100 }, deviceScaleFactor: 1 });
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    } catch (navError) {
      if (!page.url() || page.url() === "about:blank") throw navError;
    }
    await page.screenshot({ path: filePath, fullPage: true });
    return {
      url,
      screenshotUrl: `/evidence/${fileName}`,
      capturedAt: new Date().toISOString()
    };
  } finally {
    await browser.close();
  }
}

async function renderHtmlToPdf(html) {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    throw new Error(`${error.message}. Chromium kurulu degilse: npx playwright install chromium`);
  }
  try {
    const page = await browser.newPage({ viewport: { width: 1240, height: 1754 }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "networkidle" });
    return await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true
    });
  } finally {
    await browser.close();
  }
}

function renderReportDocument({ items, baseHref }) {
  const pages = items.map((item) => renderReportPage(item)).join("\n");
  const baseTag = baseHref ? `<base href="${escapeHtml(baseHref)}" />` : "";

  return `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  ${baseTag}
  <title>Derginin Tarandığı Dizin</title>
  <style>${reportStyles()}</style>
</head>
<body>
  ${pages}
</body>
</html>`;
}

function renderReportPage({ metadata = {}, verification = {}, capture = {} }) {
  const safe = (value) => escapeHtml(value || "-");
  const date = new Date();
  const accessDate = new Intl.DateTimeFormat("tr-TR").format(date);
  const evidenceUrl = verification.evidenceUrl || capture.url || "";
  const screenshot = capture.screenshotUrl || "";
  const indexName = verification.indexName || "Dizin kaydı";
  const publicationLine = buildPublicationLine(metadata);
  const sourceNote = indexName === "TR Dizin"
    ? "TR Dizin detay sayfasında bu yayına veya dergiye ait kayıt bulunmaktadır."
    : "İlgili derginin dizin bilgisinin yer aldığı kaynak sayfa bulunmaktadır.";

  return `<main class="page">
    <h1>DERGİNİN TARANDIĞI DİZİN</h1>
    <h2>1. Yayın kaydı</h2>
    <p>${safe(publicationLine)}</p>
    <h2>2. Dizin kaydı</h2>
    <div class="index-box"><strong>Tarandığı dizin:</strong><strong>${safe(indexName)}</strong></div>
    <h2>3. Kaynak</h2>
    <p>${safe(sourceNote)}<br />Erişim tarihi: ${safe(accessDate)}</p>
    <div class="link-box"><strong>Kanıt bağlantısı:</strong><br />${safe(evidenceUrl)}</div>
    <h2>4. Kayıt görünümü</h2>
    <div class="browser">
      <div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="address">${safe(evidenceUrl)}</span></div>
      <div class="shot">
        ${screenshot ? `<img src="${safe(screenshot)}" alt="Kanıt sayfası ekran görüntüsü" />` : `<div class="fallback">Ekran görüntüsü henüz alınmadı. Kanıt URL'si açıldıktan sonra bu alana görüntü eklenecek.</div>`}
      </div>
    </div>
    <p class="foot">Bu sayfa, ilgili derginin dizin bilgisinin yer aldığı kaynak sayfanın ekran görüntüsü ile birlikte üretilmiştir.</p>
  </main>`;
}

function reportStyles() {
  return `
    @page { size: A4; margin: 18mm; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f2f4f7; color: #222; font-family: Arial, Helvetica, sans-serif; }
    .page { width: 210mm; min-height: 297mm; margin: 24px auto; padding: 22mm 18mm; background: #fff; box-shadow: 0 10px 30px rgba(20, 28, 40, .12); break-after: page; page-break-after: always; }
    h1 { margin: 0 0 22px; padding-bottom: 18px; border-bottom: 1.5px solid #a71324; font-size: 31px; letter-spacing: 0; }
    h2 { margin: 24px 0 12px; color: #a71324; font-size: 22px; }
    p { font-size: 14.5px; line-height: 1.45; }
    .index-box { margin: 16px 0 24px; padding: 18px 22px; border: 1px solid #d8bfc3; background: #fbf7f8; border-radius: 8px; font-size: 17px; }
    .index-box strong:last-child { margin-left: 12px; color: #a71324; font-size: 22px; }
    .link-box { margin: 16px 0 24px; padding: 12px 16px; border: 1px solid #d7dde5; background: #f8fafc; border-radius: 8px; font-size: 13.5px; overflow-wrap: anywhere; }
    .browser { margin-top: 14px; border: 1px solid #d8dde5; border-radius: 8px; overflow: visible; }
    .bar { display: flex; align-items: center; gap: 8px; padding: 9px 12px; background: #f1f3f6; }
    .dot { width: 10px; height: 10px; border-radius: 999px; background: #d9dee7; }
    .address { flex: 1; padding: 7px 12px; border: 1px solid #d8dde5; border-radius: 999px; background: white; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .shot { padding: 12px; overflow: visible; background: white; }
    .shot img { width: 100%; height: auto; display: block; border: 1px solid #edf0f4; }
    .fallback { padding: 22px; background: #fff8e8; border: 1px solid #f2dfad; border-radius: 6px; }
    .foot { margin-top: 18px; color: #666; font-size: 12px; }
    @media print {
      body { background: #fff; }
      .page { margin: 0; box-shadow: none; }
    }
  `;
}

function buildPublicationLine(metadata) {
  const title = metadata.title || "-";
  const authors = metadata.authors || "-";
  const year = metadata.year || "-";
  const journal = metadata.journal || "-";
  const volumeIssue = metadata.volume || metadata.issue ? `${metadata.volume || "-"}(${metadata.issue || "-"})` : "-";
  const pages = metadata.pages || "-";
  const doi = metadata.doi || "-";
  return `${formatApaAuthors(authors)} (${year}). ${title}. ${journal}, ${volumeIssue}, ${pages}. https://doi.org/${doi}`;
}

function formatApaAuthors(authors) {
  const parts = String(authors || "")
    .split(/\s*;\s*/)
    .map((author) => author.trim())
    .filter(Boolean);

  const formatted = parts.map((author) => {
    if (author.includes(",")) return author.replace(/\s+/g, " ");
    const tokens = author.split(/\s+/).filter(Boolean);
    if (tokens.length < 2) return author;
    const surname = tokens[tokens.length - 1];
    const initials = tokens
      .slice(0, -1)
      .map((token) => `${token[0]?.toLocaleUpperCase("tr")}.`)
      .join(" ");
    return `${surname}, ${initials}`;
  });

  if (formatted.length <= 1) return formatted[0] || "-";
  if (formatted.length === 2) return `${formatted[0]}, & ${formatted[1]}`;
  return `${formatted.slice(0, -1).join(", ")}, & ${formatted[formatted.length - 1]}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
