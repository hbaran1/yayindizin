import React, { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const emptyMetadata = {
  title: "",
  authors: "",
  journal: "",
  year: "",
  volume: "",
  issue: "",
  pages: "",
  doi: ""
};

function App() {
  const [files, setFiles] = useState([]);
  const [records, setRecords] = useState([]);
  const [selectedId, setSelectedId] = useState("");
  const [manualUrl, setManualUrl] = useState("");
  const [exportPdfUrl, setExportPdfUrl] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const singleFileInputRef = useRef(null);
  const bulkFileInputRef = useRef(null);

  const selectedRecord = records.find((record) => record.id === selectedId) || records[0] || null;
  const metadata = selectedRecord?.metadata || emptyMetadata;
  const verification = selectedRecord?.verification || null;
  const capture = selectedRecord?.capture || null;
  const report = selectedRecord?.report || null;
  const canVerify = Boolean(metadata.doi || metadata.journal || metadata.title);
  const evidenceUrl = verification?.evidenceUrl || manualUrl;

  const statusText = useMemo(() => {
    if (busy) return busy;
    if (!records.length) return "Bekliyor";
    const completed = records.filter((record) => record.report?.reportUrl).length;
    return completed ? `${completed}/${records.length} rapor hazır` : "Kayıtlar hazır";
  }, [busy, records]);

  async function handleAnalyze(event) {
    event.preventDefault();
    if (!files.length) {
      singleFileInputRef.current?.click();
      return;
    }

    setBusy("PDF okunuyor");
    setError("");
    setRecords([]);
    setSelectedId("");
    setExportPdfUrl("");

    try {
      const form = new FormData();
      files.forEach((file) => form.append("pdfs", file));
      const data = await postForm("/api/analyze", form);
      const nextRecords = (data.items || [data]).map((item, index) => ({
        id: item.id || `${Date.now()}-${index}`,
        uploadId: item.uploadId,
        fileName: item.fileName || `PDF ${index + 1}`,
        textPreview: item.textPreview || "",
        metadata: { ...emptyMetadata, ...item.metadata },
        verification: null,
        capture: null,
        report: null,
        status: "ok"
      }));
      setRecords(nextRecords);
      setSelectedId(nextRecords[0]?.id || "");
      setManualUrl("");
      await processRecords(nextRecords);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  async function handleVerify(recordId = selectedRecord?.id) {
    const record = records.find((item) => item.id === recordId);
    if (!record) return null;

    setBusy("Kayıt aranıyor");
    setError("");
    updateRecord(record.id, { verification: null, capture: null, report: null });

    try {
      const data = await postJson("/api/verify", { metadata: record.metadata });
      updateRecord(record.id, { verification: data, metadata: enrichMetadata(record.metadata, data) });
      if (record.id === selectedRecord?.id && data.evidenceUrl) setManualUrl(data.evidenceUrl);
      return data;
    } catch (err) {
      updateRecord(record.id, { status: "error", error: err.message });
      setError(err.message);
      return null;
    } finally {
      setBusy("");
    }
  }

  async function handleCapture(recordId = selectedRecord?.id, explicitUrl = evidenceUrl) {
    const record = records.find((item) => item.id === recordId);
    const url = explicitUrl || record?.verification?.evidenceUrl;
    if (!record || !url) return null;

    setBusy("Ekran görüntüsü alınıyor");
    setError("");
    updateRecord(record.id, { capture: null, report: null });

    try {
      const data = await postJson("/api/capture", { url });
      updateRecord(record.id, { capture: data });
      return data;
    } catch (err) {
      updateRecord(record.id, { status: "error", error: err.message });
      setError(err.message);
      return null;
    } finally {
      setBusy("");
    }
  }

  async function handleReport(recordId = selectedRecord?.id) {
    const record = records.find((item) => item.id === recordId);
    if (!record) return null;

    setBusy("Son sayfa oluşturuluyor");
    setError("");

    try {
      const data = await postJson("/api/report", {
        metadata: record.metadata,
        verification: record.verification,
        capture: record.capture
      });
      updateRecord(record.id, { report: data });
      return data;
    } catch (err) {
      updateRecord(record.id, { status: "error", error: err.message });
      setError(err.message);
      return null;
    } finally {
      setBusy("");
    }
  }

  async function processRecords(inputRecords = records) {
    if (!inputRecords.length) return;
    setError("");
    setExportPdfUrl("");

    for (const record of inputRecords) {
      setSelectedId(record.id);
      setBusy(`İşleniyor: ${inputRecords.indexOf(record) + 1}/${inputRecords.length}`);

      let current = record;
      const verified = current.verification || await postJson("/api/verify", { metadata: current.metadata }).catch((err) => {
        updateRecord(record.id, { status: "error", error: err.message });
        return null;
      });
      if (!verified?.evidenceUrl) continue;
      const enrichedMetadata = enrichMetadata(current.metadata, verified);
      updateRecord(record.id, { verification: verified, metadata: enrichedMetadata });

      const shot = await postJson("/api/capture", { url: verified.evidenceUrl }).catch((err) => {
        updateRecord(record.id, { status: "error", error: err.message });
        return null;
      });
      if (!shot) continue;
      updateRecord(record.id, { capture: shot });

      current = { ...current, metadata: enrichedMetadata, verification: verified, capture: shot };
      const oneReport = await postJson("/api/report", {
        metadata: current.metadata,
        verification: verified,
        capture: shot
      }).catch((err) => {
        updateRecord(record.id, { status: "error", error: err.message });
        return null;
      });
      if (oneReport) updateRecord(record.id, { report: oneReport, status: "ok" });
    }

    setBusy("");
  }

  async function handleBulkExport() {
    const readyItems = records
      .filter((record) => record.verification && record.capture)
      .map((record) => ({
        uploadId: record.uploadId,
        metadata: record.metadata,
        verification: record.verification,
        capture: record.capture
      }));

    if (!readyItems.length) {
      setError("Dışa aktarmadan önce en az bir kayıt için doğrulama ve ekran görüntüsü alınmalıdır.");
      return;
    }

    setBusy("PDF dışa aktarılıyor");
    setError("");

    try {
      const data = await postJson("/api/export-pdf", { items: readyItems });
      setExportPdfUrl(data.pdfUrl);
      window.open(data.pdfUrl, "_blank", "noopener,noreferrer");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  function updateRecord(id, patch) {
    setRecords((current) => current.map((record) => (record.id === id ? { ...record, ...patch } : record)));
  }

  function updateMetadata(nextMetadata) {
    if (!selectedRecord) return;
    updateRecord(selectedRecord.id, { metadata: nextMetadata, verification: null, capture: null, report: null });
  }

  function selectRecord(record) {
    setSelectedId(record.id);
    setManualUrl(record.verification?.evidenceUrl || "");
  }

  function handleFileSelection(fileList) {
    setFiles(Array.from(fileList || []));
    setRecords([]);
    setSelectedId("");
    setExportPdfUrl("");
    setManualUrl("");
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">D</div>
          <div>
            <strong>Dizin Kanıt</strong>
            <span>Rapor sistemi</span>
          </div>
        </div>
        <nav>
          <a className="active">Dosya Tara</a>
          <a>Kaynaklar</a>
          <a>Kural Setleri</a>
          <a>Raporlar</a>
        </nav>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <h1>Dergi Dizin Kanıt Sistemi</h1>
            <p>Birden fazla PDF yükler, tüm yazarları kayda alır, dizin kanıtını kesmeden yakalar ve dışa aktarır.</p>
          </div>
          <div className="status-pill">{statusText}</div>
        </header>

        {error && <div className="alert">{error}</div>}

        <section className="grid">
          <Panel title="1. PDF yükle">
            <form onSubmit={handleAnalyze} className="upload-form">
              <input
                ref={singleFileInputRef}
                className="visually-hidden"
                type="file"
                accept="application/pdf"
                onChange={(event) => handleFileSelection(event.target.files)}
              />
              <input
                ref={bulkFileInputRef}
                className="visually-hidden"
                type="file"
                accept="application/pdf"
                multiple
                onChange={(event) => handleFileSelection(event.target.files)}
              />
              <div className="dropzone">
                <span>{files.length ? `${files.length} PDF seçildi` : "PDF dosyası seçin"}</span>
                <small>{files.length ? "Şimdi İşle butonuna basın." : "Tek dosya veya toplu PDF seçebilirsiniz."}</small>
                <div className="upload-actions">
                  <button type="button" className="secondary-button" onClick={() => singleFileInputRef.current?.click()}>
                    PDF Yükle
                  </button>
                  <button type="button" className="secondary-button" onClick={() => bulkFileInputRef.current?.click()}>
                    Toplu PDF Yükle
                  </button>
                </div>
              </div>
              <button type="submit" disabled={Boolean(busy)}>
                İşle
              </button>
            </form>

            {records.length > 0 && (
              <div className="record-list">
                {records.map((record, index) => (
                  <button
                    type="button"
                    key={record.id}
                    className={`record-row ${record.id === selectedRecord?.id ? "selected" : ""}`}
                    onClick={() => selectRecord(record)}
                  >
                    <span>{index + 1}. {record.metadata.title || "Başlık okunamadı"}</span>
                    <small>{record.report ? "Rapor hazır" : record.capture ? "Görüntü alındı" : record.verification ? "Kayıt bulundu" : "Okundu"}</small>
                  </button>
                ))}
              </div>
            )}
          </Panel>

          <Panel title="2. Yayın kaydı">
            <MetadataEditor metadata={metadata} onChange={updateMetadata} disabled={!selectedRecord} />
            {selectedRecord?.textPreview && (
              <details className="preview-text">
                <summary>Metin önizlemesi</summary>
                <pre>{selectedRecord.textPreview}</pre>
              </details>
            )}
          </Panel>

          <Panel title="3. Dizin doğrulama">
            <div className="actions">
              <button onClick={() => handleVerify()} disabled={!canVerify || Boolean(busy)}>
                Doğrula
              </button>
              <button onClick={() => handleCapture()} disabled={!evidenceUrl || Boolean(busy)}>
                Ekran Görüntüsü Al
              </button>
              <button onClick={() => handleReport()} disabled={!capture || Boolean(busy)}>
                Rapor Oluştur
              </button>
              <button onClick={handleBulkExport} disabled={!records.some((record) => record.verification && record.capture) || Boolean(busy)}>
                PDF Dışa Aktar
              </button>
            </div>

            {verification && <VerificationResult verification={verification} />}

            {verification?.requiresManualUrl && (
              <label className="manual-url">
                <span>Kanıt URL’si</span>
                <input
                  value={manualUrl}
                  onChange={(event) => setManualUrl(event.target.value)}
                  placeholder="https://..."
                />
              </label>
            )}

            {exportPdfUrl && (
              <a className="open-report block-link" href={exportPdfUrl} target="_blank" rel="noreferrer">
                PDF çıktısını aç
              </a>
            )}
          </Panel>

          <Panel title="4. Kanıt ekranı">
            {capture?.screenshotUrl ? (
              <div className="screenshot-box">
                <a href={capture.url} target="_blank" rel="noreferrer">
                  {capture.url}
                </a>
                <div className="screenshot-scroll">
                  <img src={capture.screenshotUrl} alt="Kanıt sayfası ekran görüntüsü" />
                </div>
              </div>
            ) : (
              <EmptyState text="Kanıt sayfası bulunduktan sonra ekran görüntüsü burada görünür." />
            )}
          </Panel>
        </section>

        <section className="report-section">
          <div className="section-heading">
            <h2>Son sayfa önizlemesi</h2>
          </div>
          {report?.html ? (
            <iframe className="report-frame" srcDoc={report.html} title="Son sayfa önizlemesi" />
          ) : (
            <EmptyState text="Son sayfa oluşturulduğunda rapor önizlemesi burada açılır." />
          )}
        </section>
      </main>
    </div>
  );
}

function Panel({ title, children }) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function MetadataEditor({ metadata, onChange, disabled }) {
  const fields = [
    ["title", "Makale"],
    ["authors", "Yazarlar"],
    ["journal", "Dergi"],
    ["year", "Yıl"],
    ["volume", "Cilt"],
    ["issue", "Sayı"],
    ["pages", "Sayfa"],
    ["doi", "DOI"]
  ];

  return (
    <div className="metadata-grid">
      {fields.map(([key, label]) => (
        <label key={key} className={key === "title" || key === "authors" || key === "journal" || key === "doi" ? "wide" : ""}>
          <span>{label}</span>
          <input
            disabled={disabled}
            value={metadata[key] || ""}
            onChange={(event) => onChange({ ...metadata, [key]: event.target.value })}
          />
        </label>
      ))}
    </div>
  );
}

function VerificationResult({ verification }) {
  return (
    <div className="verification">
      <div className={`result-banner ${verification.status === "found" ? "ok" : "warn"}`}>
        <strong>{verification.message}</strong>
        {verification.evidenceUrl && (
          <a href={verification.evidenceUrl} target="_blank" rel="noreferrer">
            Kanıt bağlantısı
          </a>
        )}
      </div>

      <table>
        <thead>
          <tr>
            <th>Kaynak</th>
            <th>Durum</th>
            <th>Açıklama</th>
          </tr>
        </thead>
        <tbody>
          {verification.sources?.map((source) => (
            <tr key={`${source.label}-${source.url}`}>
              <td>
                {source.url ? (
                  <a href={source.url} target="_blank" rel="noreferrer">
                    {source.label}
                  </a>
                ) : (
                  source.label
                )}
              </td>
              <td>{source.status}</td>
              <td>{source.details}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {verification.warnings?.length > 0 && (
        <div className="warnings">
          {verification.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyState({ text }) {
  return <div className="empty-state">{text}</div>;
}

function enrichMetadata(metadata, verification) {
  const publication = verification?.publication;
  if (!publication) return metadata;

  return {
    ...metadata,
    title: publication.title || metadata.title,
    authors: publication.authors || metadata.authors,
    journal: publication.journal || metadata.journal,
    year: publication.year || metadata.year,
    volume: publication.volume || metadata.volume,
    issue: publication.issue || metadata.issue,
    pages: publication.pages || metadata.pages,
    doi: publication.doi || metadata.doi
  };
}

async function postForm(url, body) {
  const response = await fetch(url, { method: "POST", body });
  return parseResponse(response);
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return parseResponse(response);
}

async function parseResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "İşlem tamamlanamadı.");
  return data;
}

createRoot(document.getElementById("root")).render(<App />);
