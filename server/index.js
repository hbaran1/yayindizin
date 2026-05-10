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

app.post("/api/fetch-by-doi", async (req, res) => {
  try {
    const rawDoi = String((req.body && req.body.doi) || "").trim();
    const doi = rawDoi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/[.,;)]+$/, "");
    if (!doi || !/^10\.\d{4,9}\/.+/.test(doi)) {
      return res.status(400).json({ error: "Gecerli bir DOI girin (orn: 10.xxxx/yyyy)." });
    }

    const items = [];
    const failures = [];
    try {
      const file = await fetchPdfByDoi(doi);
      const item = await analyzePdfFile(file);
      items.push(item);
    } catch (error) {
      console.error(`DOI indirme hatasi (${doi}):`, error.message);
      failures.push({ doi, error: error.message });
    }

    if (!items.length) {
      const detail = failures.map((f) => `${f.doi}: ${f.error}`).join(" | ");
      return res.status(404).json({ error: `DOI icin ucretsiz erisimli PDF bulunamadi. ${detail}` });
    }

    res.json({
      fileName: items[0]?.fileName || "",
      textPreview: items[0]?.textPreview || "",
      metadata: items[0]?.metadata || {},
      items,
      failures
    });
  } catch (error) {
    console.error("/api/fetch-by-doi fatal:", error);
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

async function fetchPdfByDoi(doi) {
  const candidates = [];

  try {
    const trDizin = await findTrDizinPublicationByDoi(doi);
    const candidate = trDizin?.source?.fullTextUrl || trDizin?.source?.documentUrl || trDizin?.source?.pdfUrl;
    if (candidate) candidates.push({ source: "TR Dizin", url: candidate });
  } catch {}

  try {
    const unpaywall = await fetchJson(
      `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=baranhuseyin@gmail.com`,
      8000
    );
    const oaPdf = unpaywall?.best_oa_location?.url_for_pdf;
    const oaLanding = unpaywall?.best_oa_location?.url;
    if (oaPdf) candidates.push({ source: "Unpaywall", url: oaPdf });
    else if (oaLanding) candidates.push({ source: "Unpaywall (landing)", url: oaLanding });
  } catch {}

  try {
    const crossref = await fetchJson(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, 8000);
    const pdfLink = (crossref?.message?.link || []).find((l) => /pdf/i.test(l["content-type"] || "") || /pdf/i.test(l.URL || ""));
    if (pdfLink?.URL) candidates.push({ source: "Crossref", url: pdfLink.URL });
  } catch {}

  if (!candidates.length) {
    throw new Error(`Hicbir kaynakta acik erisimli PDF bulunamadi (TR Dizin / Unpaywall / Crossref).`);
  }

  const errors = [];
  for (const candidate of candidates) {
    try {
      const file = await downloadPdfTo(candidate.url, doi);
      console.log(`PDF ${candidate.source} araciligiyla indirildi: ${candidate.url}`);
      return file;
    } catch (error) {
      errors.push(`${candidate.source}: ${error.message}`);
    }
  }
  throw new Error(`PDF aday URL'lerinin hicbiri indirilemedi. ${errors.join(" | ")}`);
}

async function fetchUrlContent(url, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; DergiDizinKanit/0.1)",
        accept: "application/pdf,text/html,*/*"
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      buffer,
      contentType: response.headers.get("content-type") || "",
      finalUrl: response.url || url
    };
  } finally {
    clearTimeout(timeout);
  }
}

function isPdfBuffer(buffer) {
  return buffer.length > 1024 && buffer.slice(0, 4).toString("ascii") === "%PDF";
}

function extractPdfLinkFromHtml(html, baseUrl) {
  const tryUrl = (raw) => {
    if (!raw) return null;
    try {
      return new URL(raw, baseUrl).toString();
    } catch {
      return null;
    }
  };

  // 1. citation_pdf_url meta tag (Highwire/Google Scholar standard, en yaygin)
  let m = html.match(/<meta[^>]+name=["']citation_pdf_url["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']citation_pdf_url["']/i);
  if (m) {
    const u = tryUrl(m[1]);
    if (u) return u;
  }

  // 2. <link rel=... type=application/pdf>
  m = html.match(/<link[^>]+type=["']application\/pdf["'][^>]+href=["']([^"']+)["']/i)
    || html.match(/<link[^>]+href=["']([^"']+)["'][^>]+type=["']application\/pdf["']/i);
  if (m) {
    const u = tryUrl(m[1]);
    if (u) return u;
  }

  // 3. DergiPark / OJS pattern: /download/article-file/<id>
  m = html.match(/href=["']([^"']*\/download\/article-file\/\d+)["']/i);
  if (m) {
    const u = tryUrl(m[1]);
    if (u) return u;
  }

  // 4. Genel: .pdf uzantili anchor
  m = html.match(/href=["']([^"']+\.pdf(?:\?[^"']*)?)["']/i);
  if (m) {
    const u = tryUrl(m[1]);
    if (u) return u;
  }

  return null;
}

async function downloadPdfTo(url, doi) {
  let { buffer, contentType, finalUrl } = await fetchUrlContent(url);

  // Eger landing sayfasi (HTML) geldiyse icindeki PDF link'ini cikar ve onu indir
  if (!isPdfBuffer(buffer)) {
    const looksHtml = /text\/html/i.test(contentType)
      || buffer.slice(0, 64).toString("utf8").trim().startsWith("<");
    if (looksHtml) {
      const html = buffer.toString("utf-8");
      const pdfLink = extractPdfLinkFromHtml(html, finalUrl || url);
      if (!pdfLink) {
        throw new Error("Landing sayfasinda PDF bagi bulunamadi (acik erisim olmayabilir)");
      }
      console.log(`Landing sayfasindan PDF linki cikarildi: ${pdfLink}`);
      ({ buffer } = await fetchUrlContent(pdfLink));
      if (!isPdfBuffer(buffer)) {
        throw new Error(`Cikarilan PDF linki gecerli PDF dondurmedi: ${pdfLink}`);
      }
    } else {
      throw new Error("Indirilen icerik PDF degil");
    }
  }

  if (buffer.length < 1024) {
    throw new Error(`Dosya cok kucuk (${buffer.length} bayt) — gecerli PDF degil`);
  }

  const filename = crypto.randomBytes(16).toString("hex");
  const filepath = path.join(uploadDir, filename);
  await fs.writeFile(filepath, buffer);
  const safeName = `${doi.replace(/[^A-Za-z0-9._-]+/g, "_")}.pdf`;
  return { path: filepath, filename, originalname: safeName, size: buffer.length };
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

  // Her zaman dergi indeks sayfasini sorgula (yalnizca fallback degil) — bir dergi
  // birden cok dizinde bulunabilir, hepsini listelemek istiyoruz.
  const journalWebEvidence = await findJournalIndexPage(journal?.source, normalized.journal);
  if (journalWebEvidence) {
    sources.push({
      label: "Dergi dizin sayfası",
      status: "bulundu",
      url: journalWebEvidence.url,
      details: journalWebEvidence.details
    });
  }

  // Tum dizinleri birlestir: TR Dizin (publication varsa) + dergi sayfasindan bulunanlar
  const indexSet = new Set();
  if (publication) indexSet.add("TR Dizin");
  if (journal?.source?.journalDatabase?.length && !indexSet.has("TR Dizin")) {
    indexSet.add("TR Dizin");
  }
  for (const idx of journalWebEvidence?.indexes || []) indexSet.add(idx);
  const indexes = [...indexSet];

  // Ekran goruntusu icin: dergi dizin sayfasi (dizinlerin gorsel kaniti) oncelikli.
  // Yayin URL'i (TR Dizin makale detay) ikincil, dergi detayi son care.
  const evidenceUrl = journalWebEvidence?.url
    || publication?.url
    || (journal ? `https://search.trdizin.gov.tr/tr/dergi/detay/${journal.source.id}` : "");
  const publicationUrl = publication?.url || "";
  const indexName = indexes.length === 1
    ? indexes[0]
    : (indexes.length > 1 ? indexes.join(", ") : (publication ? "TR Dizin" : inferIndexName(journalWebEvidence, journal)));

  let status;
  let requiresManualUrl;
  let message;
  if (journalWebEvidence?.url) {
    status = "found";
    requiresManualUrl = false;
    message = indexes.length > 1
      ? `Dergi dizin sayfası bulundu. ${indexes.length} dizinde tarandı.`
      : "Dergi dizin sayfası bulundu.";
  } else if (publication?.url) {
    status = "found";
    requiresManualUrl = false;
    message = "TR Dizin yayın kaydı bulundu.";
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
    publicationUrl,
    indexName,
    indexes,
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

async function fetchJson(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
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
  const webAddress = journal?.webAddress;

  if (webAddress) {
    const base = normalizeBaseUrl(webAddress);

    // Once dedicated dizin sayfalari (en odakli, en iyi gorsel kanit)
    candidates.push(
      `${base}/pages/abstracting-and-indexing`,
      `${base}/abstracting-and-indexing`,
      `${base}/indexing-and-abstracting`,
      `${base}/tarandigi-dizinler`,
      `${base}/dizinler`,
      `${base}/indexing`,
      `${base}/abstracting-indexing`,
      `${base}/index`
    );

    // Sonra dergi ana sayfasi (DergiPark gibi dedicated yol olmayan platformlar icin)
    try {
      const fullUrl = /^https?:\/\//i.test(webAddress) ? webAddress : `https://${webAddress}`;
      const cleanFull = fullUrl.replace(/\/$/, "");
      if (!candidates.includes(cleanFull)) candidates.push(cleanFull);
    } catch {}
  }

  // 1. PASS — HTTP fetch (hizli, paralel). Cogu yayinci icin yeterli.
  const uniqueCandidates = [...new Set(candidates)];
  const httpResults = await Promise.all(
    uniqueCandidates.map(async (url) => ({ url, page: await probeIndexPage(url) }))
  );

  const collected = new Set();
  let bestUrl = null;
  let bestScore = 0;
  for (const { url, page } of httpResults) {
    if (!page) continue;
    for (const term of page.terms) collected.add(term);
    if (page.terms.length > bestScore) {
      bestScore = page.terms.length;
      bestUrl = url;
    }
  }

  // 2. PASS — Cloudflare/bot-protection Playwright fallback. HTTP fetch sifir
  // dizin getirdiyse (cogunlukla 403 yiyince) gercek tarayici ile dene. Yavas
  // ama JS challenge'larini gecer.
  if (collected.size === 0 && uniqueCandidates.length > 0) {
    console.log(`[findJournalIndexPage] HTTP'den dizin gelmedi, Playwright fallback`);
    // En olasi 2 URL: ilk dedicated path + homepage
    const homepageUrl = uniqueCandidates[uniqueCandidates.length - 1];
    const dedicatedUrl = uniqueCandidates[0];
    const fallbackUrls = [...new Set([dedicatedUrl, homepageUrl])];
    for (const url of fallbackUrls) {
      const page = await probeIndexPageWithPlaywright(url);
      if (page) {
        for (const term of page.terms) collected.add(term);
        if (page.terms.length > bestScore) {
          bestScore = page.terms.length;
          bestUrl = url;
        }
      }
    }
  }

  if (!bestUrl) return null;
  const indexes = [...collected];
  return {
    url: bestUrl,
    indexes,
    details: indexes.length ? indexes.join(", ") : "Dizin sayfası bulundu."
  };
}

async function probeIndexPageWithPlaywright(url) {
  let browser = null;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1366, height: 1100 },
      userAgent: BROWSER_UA,
      locale: "tr-TR"
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    const html = await page.content();
    const terms = extractIndexTerms(html);
    console.log(`[probeIndexPageWithPlaywright] ${url} -> ${terms.length} dizin: ${terms.join(", ")}`);
    if (!terms.length) return null;
    return { url, terms };
  } catch (error) {
    console.log(`[probeIndexPageWithPlaywright] ${url} -> ERROR: ${error.message}`);
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

function normalizeBaseUrl(value) {
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  const parsed = new URL(withProtocol);
  return `${parsed.protocol}//${parsed.host}`.replace(/\/$/, "");
}

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function probeIndexPage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent": BROWSER_UA,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "tr-TR,tr;q=0.9,en;q=0.8",
        "accept-encoding": "gzip, deflate, br"
      }
    });
    clearTimeout(timeout);
    if (!response.ok) {
      console.log(`[probeIndexPage] ${url} -> HTTP ${response.status}`);
      return null;
    }
    const html = await response.text();
    const terms = extractIndexTerms(html);
    console.log(`[probeIndexPage] ${url} -> ${terms.length} dizin: ${terms.join(", ")}`);
    if (!terms.length) return null;
    return { url, terms };
  } catch (error) {
    clearTimeout(timeout);
    console.log(`[probeIndexPage] ${url} -> ERROR: ${error.message}`);
    return null;
  }
}

// HTML icindeki goruntu alt-text'lerini ve link title'larini da kapsayan
// metin cikarici. Cogu DergiPark dergisi dizinleri logo olarak gosterir,
// label img alt metninde tutulur.
function extractTextFromHtml(html) {
  const altTexts = [...html.matchAll(/\b(?:alt|title)\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
  const visibleText = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  return [visibleText, ...altTexts].join(" ");
}

function extractIndexTerms(html) {
  const text = extractTextFromHtml(html);

  // Genis dizin tani kütüphanesi. Sira: en spesifik patterns ilk
  const indexPatterns = [
    ["Web of Science (SCI-EXPANDED)", /(?:Science\s*Citation\s*Index\s*Expanded|SCI[-\s]*EXPANDED|SCIE\b)/i],
    ["Web of Science (SSCI)", /(?:Social\s*Sciences\s*Citation\s*Index|\bSSCI\b)/i],
    ["Web of Science (AHCI)", /(?:Arts\s*&?\s*Humanities\s*Citation\s*Index|\bA[&\s]?HCI\b)/i],
    ["Web of Science (ESCI)", /(?:Emerging\s*Sources\s*Citation\s*Index|\bESCI\b)/i],
    ["Web of Science", /Web\s*of\s*Science|\bWoS\b|Clarivate/i],
    ["Scopus", /\bScopus\b/i],
    ["TR Dizin", /TR\s*Diz[ıi]n|TRDiz[ıi]n/i],
    ["ULAKBİM", /ULAKB[İI]M/i],
    ["DOAJ", /(?:Directory\s*of\s*Open\s*Access\s*Journals|\bDOAJ\b)/i],
    ["ERIH PLUS", /ERIH[-\s]*PLUS/i],
    ["MLA International Bibliography", /MLA\s*(?:International\s*)?Bibliography/i],
    ["EBSCO", /\bEBSCO(?:host)?\b/i],
    ["ProQuest", /Pro\s*Quest/i],
    ["JSTOR", /\bJSTOR\b/i],
    ["Google Scholar", /Google\s*Scholar/i],
    ["Index Copernicus", /Index\s*Copernicus|ICI\s*World\s*of\s*Journals/i],
    ["Sobiad", /\bSobiad\b/i],
    ["Asos İndeks", /Asos(?:\s*[Iİi]ndeks)?/i],
    ["TÜBİTAK", /T[ÜU]B[İI]TAK/i],
    ["CrossRef", /Cross\s*Ref/i],
    ["WorldCat", /World\s*Cat/i],
    ["PubMed", /Pub\s*Med/i],
    ["Embase", /\bEmbase\b/i],
    ["CINAHL", /\bCINAHL\b/i],
    ["DBLP", /\bDBLP\b/i],
    ["MathSciNet", /Math\s*Sci\s*Net/i],
    ["zbMATH", /zb\s*MATH/i],
    ["Index Islamicus", /Index\s*Islamicus/i],
    ["Religious & Theological Abstracts", /Religious\s*(?:&|and)?\s*Theological\s*Abstracts/i],
    ["ATLA Religion Database", /ATLA\s*Religion(?:\s*Database)?/i],
    ["Scilit", /\bScilit\b/i],
    ["Dimensions", /\bDimensions\b/i],
    ["Lens.org", /\blens\.org\b/i],
    ["BASE", /\bBASE\s*(?:Bielefeld|Search)/i],
    ["OpenAIRE", /Open\s*AIRE/i],
    ["CABI", /\bCABI\b|CAB\s*Direct/i],
    ["Index Cerist", /Index\s*Cerist/i],
    ["Türk Eğitim İndeksi", /T[üu]rk\s*E[ğg]itim\s*[İi]ndeksi/i],
    ["İdealOnline", /[İi]deal\s*Online/i],
    ["Akademia Sosyal Bilimler İndeksi (ASOS)", /Akademia\s*Sosyal\s*Bilimler\s*[İi]ndeksi/i],
    ["DRJI", /\bDRJI\b|Directory\s*of\s*Research\s*Journals\s*Indexing/i],
    ["ESJI", /\bESJI\b|Eurasian\s*Scientific\s*Journal\s*Index/i]
  ];

  // Web of Science alt-koleksiyonlarindan biri varsa "Web of Science" genel etiketini gizle
  const found = new Set();
  for (const [label, regex] of indexPatterns) {
    if (regex.test(text)) found.add(label);
  }
  const hasSpecificWos = ["Web of Science (SCI-EXPANDED)", "Web of Science (SSCI)", "Web of Science (AHCI)", "Web of Science (ESCI)"]
    .some((l) => found.has(l));
  if (hasSpecificWos) found.delete("Web of Science");

  return [...found];
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
  const indexes = Array.isArray(verification.indexes) ? verification.indexes : [];
  const indexName = verification.indexName || "Dizin kaydı";
  const publicationLine = buildPublicationLine(metadata);

  const indexHeading = indexes.length > 1 ? "Tarandığı dizinler" : "Tarandığı dizin";
  const indexBlock = indexes.length > 0
    ? `<div class="index-box">
        <strong>${indexHeading} (${indexes.length}):</strong>
        <ul class="index-list">${indexes.map((i) => `<li>${safe(i)}</li>`).join("")}</ul>
      </div>`
    : `<div class="index-box"><strong>Tarandığı dizin:</strong><strong>${safe(indexName)}</strong></div>`;

  const sourceNote = indexes.length > 1
    ? "Aşağıda listelenen dizinler, derginin resmi sayfasında ve TR Dizin kaydında tespit edilmiştir."
    : (indexName === "TR Dizin"
      ? "TR Dizin detay sayfasında bu yayına veya dergiye ait kayıt bulunmaktadır."
      : "İlgili derginin dizin bilgisinin yer aldığı kaynak sayfa bulunmaktadır.");

  return `<main class="page">
    <h1>DERGİNİN TARANDIĞI DİZİN</h1>
    <h2>1. Yayın kaydı</h2>
    <p>${safe(publicationLine)}</p>
    <h2>2. Dizin kaydı</h2>
    ${indexBlock}
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
    .index-box > strong:first-child { display: block; margin-bottom: 8px; color: #5a1a23; font-size: 15px; }
    .index-box strong:last-child:not(:first-child) { margin-left: 12px; color: #a71324; font-size: 22px; }
    .index-list { margin: 0; padding-left: 22px; columns: 2; column-gap: 28px; }
    .index-list li { margin: 4px 0; color: #a71324; font-weight: 700; font-size: 15px; break-inside: avoid; }
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
