import { useState, useRef } from "react";

const CLAUDE_MODEL = "claude-sonnet-4-20250514";

const SYSTEM_PROMPT = `You are an expert Quality Engineer specializing in Li-Ion battery cell manufacturing with deep knowledge of AIAG-VDA FMEA 2024 and Control Plan standards.

You will receive a BATCH of PFMEA rows (CSV format) and must analyze each one to generate Control Plan rows.

SELECTION LOGIC — Include a row in CP if ANY of these apply:
- Action Priority (AP) = H or M
- Severity >= 8
- Detection >= 7
- SC or CC flag is marked YES
- Failure mode touches Li-Ion critical parameters (see below)

LI-ION ALWAYS-INCLUDE (regardless of AP/RPN):
Thermal runaway, short circuit, electrolyte leakage, electrode alignment/overhang, moisture ingress, formation temperature/voltage deviation, coating weight, NMP residual, tab welding strength/resistance, electrolyte fill volume/weight, cell sealing integrity, separator defects/holes/folds.

CLASSIFICATION RULES:
CC (Critical Characteristic): Severity=9-10 AND safety/regulatory link AND SC_CC_Flag=CC
SC (Significant Characteristic): Severity=7-8 OR Detection>=7 OR SC_CC_Flag=SC OR influences CC downstream
blank: included row that does not meet CC or SC criteria

OUTPUT: Return ONLY a valid JSON array. No text before or after. No markdown. No code fences.
Each object must have exactly these fields — keep all text SHORT (under 100 chars each):
{
  "pfmea_function_id": "string",
  "process_step": "string",
  "process_step_no": "string",
  "product_characteristic": "string max 80 chars",
  "process_characteristic": "string max 80 chars",
  "classification": "CC or SC or blank",
  "classification_symbol": "▼ or ◆ or —",
  "selection_rationale": "string max 120 chars — cite S/O/D, AP, trigger",
  "classification_rationale": "string max 120 chars — cite rule applied",
  "failure_mode": "string max 80 chars",
  "failure_effect": "string max 80 chars",
  "severity": number,
  "occurrence": number,
  "detection": number,
  "ap_score": "H or M or L",
  "spec_value": "string",
  "spec_unit": "string",
  "control_method": "string max 80 chars",
  "measurement_device": "string max 80 chars",
  "sample_size": "string",
  "sample_frequency": "string",
  "reaction_plan": "string max 120 chars",
  "responsible": "string",
  "confidence": number between 0.5 and 1.0
}

If a PFMEA row does NOT qualify for CP (AP=L, S<7, no trigger), skip it entirely — do not include it in the array.
CRITICAL: Keep all string values SHORT. This is mandatory to avoid truncation.`;

const STATUS_CONFIG = {
  PENDING:   { label: "Pending Review", color: "#f59e0b", bg: "#fef3c7" },
  IN_REVIEW: { label: "In Review",      color: "#3b82f6", bg: "#dbeafe" },
  APPROVED:  { label: "Approved",       color: "#10b981", bg: "#d1fae5" },
  REJECTED:  { label: "Needs Rework",   color: "#ef4444", bg: "#fee2e2" },
  RELEASED:  { label: "Released",       color: "#6d28d9", bg: "#ede9fe" },
};

const CLASS_CONFIG = {
  CC:    { symbol: "▼", color: "#dc2626", bg: "#fef2f2", label: "Critical" },
  SC:    { symbol: "◆", color: "#d97706", bg: "#fffbeb", label: "Significant" },
  blank: { symbol: "—", color: "#6b7280", bg: "#f9fafb", label: "Standard" },
};

function parseCsvToRows(text) {
  const lines = text.trim().split("\n").filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, ""));
  return lines.slice(1).map(line => {
    const vals = [];
    let cur = "", inQ = false;
    for (let c of line) {
      if (c === '"') { inQ = !inQ; }
      else if (c === "," && !inQ) { vals.push(cur.trim()); cur = ""; }
      else cur += c;
    }
    vals.push(cur.trim());
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] || ""; });
    return obj;
  });
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

function rowsToCsvText(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(","), ...rows.map(r => headers.map(h => `"${String(r[h] || "").replace(/"/g, '""')}"`).join(","))];
  return lines.join("\n");
}

async function analyzeChunk(csvChunk) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 8000,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Analyze this PFMEA batch and return CP rows as JSON array:\n\n${csvChunk}` }]
    })
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  const text = data.content?.find(b => b.type === "text")?.text || "[]";
  const clean = text.replace(/```json|```/g, "").trim();
  // Find JSON array in response robustly
  const start = clean.indexOf("[");
  const end = clean.lastIndexOf("]");
  if (start === -1 || end === -1) return [];
  return JSON.parse(clean.substring(start, end + 1));
}

export default function ControlPlanApp() {
  const [stage, setStage] = useState("upload");
  const [files, setFiles] = useState({ pfmea: null, btlah: null, drawing: null, processflow: null, processspec: null });
  const [cpRows, setCpRows] = useState([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeProgress, setAnalyzeProgress] = useState({ current: 0, total: 0, status: "" });
  const [error, setError] = useState("");
  const [selectedRow, setSelectedRow] = useState(null);
  const [cpMeta, setCpMeta] = useState({ title: "Li-Ion Cell Production Control Plan", revision: "A", date: new Date().toISOString().split("T")[0], status: "DRAFT" });
  const [revisionHistory, setRevisionHistory] = useState([]);
  const [filterClass, setFilterClass] = useState("ALL");
  const [filterStatus, setFilterStatus] = useState("ALL");
  const [discussionInput, setDiscussionInput] = useState("");
  const [activeTab, setActiveTab] = useState("cp");
  const fileRefs = { pfmea: useRef(), btlah: useRef(), drawing: useRef(), processflow: useRef(), processspec: useRef() };

  const handleFile = (key, file) => setFiles(f => ({ ...f, [key]: file }));

  const readFile = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsText(file);
  });

  const analyzePFMEA = async () => {
    if (!files.pfmea) { setError("Please upload your PFMEA file first."); return; }
    setAnalyzing(true);
    setError("");
    setAnalyzeProgress({ current: 0, total: 0, status: "Reading PFMEA file..." });
    try {
      const pfmeaText = await readFile(files.pfmea);
      const pfmeaRows = parseCsvToRows(pfmeaText);
      if (pfmeaRows.length === 0) throw new Error("Could not parse CSV. Check that the file has headers and data rows.");

      const BATCH_SIZE = 8;
      const chunks = chunkArray(pfmeaRows, BATCH_SIZE);
      setAnalyzeProgress({ current: 0, total: chunks.length, status: `Analyzing ${pfmeaRows.length} PFMEA rows in ${chunks.length} batches...` });

      const allResults = [];
      for (let i = 0; i < chunks.length; i++) {
        setAnalyzeProgress({ current: i + 1, total: chunks.length, status: `Processing batch ${i + 1} of ${chunks.length} (rows ${i * BATCH_SIZE + 1}–${Math.min((i + 1) * BATCH_SIZE, pfmeaRows.length)})...` });
        const chunkCsv = rowsToCsvText(chunks[i]);
        const results = await analyzeChunk(chunkCsv);
        allResults.push(...results);
        // Small delay between calls to be safe
        if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 800));
      }

      const numbered = allResults.map((r, i) => ({
        ...r,
        id: `CP-${String(i + 1).padStart(3, "0")}`,
        review_status: "PENDING",
        discussion: [],
        approved_by: "",
        approved_date: "",
      }));

      setCpRows(numbered);
      setRevisionHistory([{
        revision: "A",
        date: new Date().toISOString().split("T")[0],
        action: `Initial AI Draft — ${numbered.length} CP rows from ${pfmeaRows.length} PFMEA entries`,
        by: "Claude AI",
        rowCount: numbered.length
      }]);
      setStage("cp");
    } catch (e) {
      setError("Analysis failed: " + e.message);
    }
    setAnalyzing(false);
  };

  const updateRow = (id, field, value) => setCpRows(rows => rows.map(r => r.id === id ? { ...r, [field]: value } : r));
  const addDiscussion = (rowId, text) => {
    if (!text.trim()) return;
    setCpRows(rows => rows.map(r => r.id === rowId ? { ...r, discussion: [...(r.discussion || []), { text, author: "Quality Engineer", date: new Date().toLocaleString(), id: Date.now() }] } : r));
    setDiscussionInput("");
  };
  const approveRow = (id) => setCpRows(rows => rows.map(r => r.id === id ? { ...r, review_status: "APPROVED", approved_by: "QE", approved_date: new Date().toISOString().split("T")[0] } : r));
  const rejectRow = (id) => setCpRows(rows => rows.map(r => r.id === id ? { ...r, review_status: "REJECTED" } : r));
  const setInReview = (id) => setCpRows(rows => rows.map(r => r.id === id ? { ...r, review_status: "IN_REVIEW" } : r));

  const releaseCP = () => {
    const notApproved = cpRows.filter(r => r.review_status !== "APPROVED");
    if (notApproved.length > 0) { setError(`${notApproved.length} rows still not approved. Approve all rows before releasing.`); return; }
    setError("");
    const lastRev = revisionHistory[revisionHistory.length - 1]?.revision || "@";
    const newRev = String.fromCharCode(lastRev.charCodeAt(0) + 1);
    setRevisionHistory(h => [...h, { revision: newRev, date: new Date().toISOString().split("T")[0], action: "Official Release — all rows approved", by: "Quality Engineering", rowCount: cpRows.length }]);
    setCpMeta(m => ({ ...m, revision: newRev, status: "RELEASED" }));
    setCpRows(rows => rows.map(r => ({ ...r, review_status: "RELEASED" })));
    setStage("released");
  };

  const exportCSV = () => {
    const headers = ["ID","Process Step No","Process Step","Product Characteristic","Process Characteristic","Classification","Spec Value","Unit","Control Method","Measurement Device","Sample Size","Frequency","Reaction Plan","Responsible","AP","S","O","D","Status","Approved By","Approved Date","Selection Rationale","Classification Rationale","Confidence"];
    const dataRows = cpRows.map(r => [r.id, r.process_step_no, r.process_step, r.product_characteristic, r.process_characteristic, r.classification, r.spec_value, r.spec_unit, r.control_method, r.measurement_device, r.sample_size, r.sample_frequency, r.reaction_plan, r.responsible, r.ap_score, r.severity, r.occurrence, r.detection, r.review_status, r.approved_by, r.approved_date, r.selection_rationale, r.classification_rationale, r.confidence].map(v => `"${String(v || "").replace(/"/g, '""')}"`));
    const csv = [headers.map(h => `"${h}"`), ...dataRows].map(r => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `ControlPlan_Rev${cpMeta.revision}_${cpMeta.date}.csv`; a.click();
  };

  const filteredRows = cpRows.filter(r => {
    const classOk = filterClass === "ALL" || r.classification === filterClass;
    const statusOk = filterStatus === "ALL" || r.review_status === filterStatus;
    return classOk && statusOk;
  });

  const stats = {
    total: cpRows.length,
    cc: cpRows.filter(r => r.classification === "CC").length,
    sc: cpRows.filter(r => r.classification === "SC").length,
    approved: cpRows.filter(r => r.review_status === "APPROVED" || r.review_status === "RELEASED").length,
    pending: cpRows.filter(r => r.review_status === "PENDING").length,
  };

  const sel = selectedRow ? cpRows.find(r => r.id === selectedRow) : null;

  return (
    <div style={{ fontFamily: "'IBM Plex Sans','Segoe UI',sans-serif", background: "#f0f4f8", minHeight: "100vh", color: "#1e293b" }}>

      {/* Header */}
      <div style={{ background: "linear-gradient(135deg,#0f172a 0%,#1e3a5f 100%)", color: "white", padding: "14px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", boxShadow: "0 2px 12px rgba(0,0,0,0.3)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ background: "#3b82f6", borderRadius: 8, width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17 }}>🔋</div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>Li-Ion Control Plan Assistant</div>
            <div style={{ fontSize: 11, color: "#94a3b8" }}>AIAG 2024 · PFMEA-driven · AI-Powered</div>
          </div>
        </div>
        {(stage === "cp" || stage === "released") && (
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ textAlign: "right", fontSize: 11, color: "#94a3b8" }}>
              <div>{cpMeta.title}</div>
              <div>Rev. {cpMeta.revision} · {cpMeta.date}</div>
            </div>
            <div style={{ background: cpMeta.status === "RELEASED" ? "#10b981" : "#f59e0b", color: "white", padding: "4px 12px", borderRadius: 20, fontSize: 12, fontWeight: 700 }}>{cpMeta.status}</div>
          </div>
        )}
      </div>

      {/* ── UPLOAD STAGE ── */}
      {stage === "upload" && (
        <div style={{ maxWidth: 680, margin: "40px auto", padding: "0 20px" }}>
          <div style={{ background: "white", borderRadius: 16, padding: 32, boxShadow: "0 4px 20px rgba(0,0,0,0.08)" }}>
            <h2 style={{ margin: "0 0 6px", fontSize: 20, fontWeight: 700 }}>Upload Your Documents</h2>
            <p style={{ margin: "0 0 24px", color: "#64748b", fontSize: 13 }}>Claude analyzes your PFMEA and generates a draft Control Plan using AIAG 2024 SC/CC rules and Li-Ion specific triggers.</p>

            {[
              { key: "pfmea",       label: "PFMEA File",                   required: true,  accept: ".csv,.xml", icon: "📋", desc: "CSV or XML export from APIS IQ-RMEA" },
              { key: "btlah",       label: "BTLAH — Product Specification", required: false, accept: ".pdf,.txt", icon: "📄", desc: "Lastenheft / product requirements (PDF or TXT)" },
              { key: "drawing",     label: "Product Drawing",               required: false, accept: ".pdf,.png,.jpg", icon: "📐", desc: "Engineering drawing (PDF or image)" },
              { key: "processflow", label: "Process Flow Chart",            required: false, accept: ".pdf,.png,.jpg", icon: "🔄", desc: "Process flow diagram" },
              { key: "processspec", label: "Process Specification Values",  required: false, accept: ".pdf,.csv,.txt", icon: "⚙️", desc: "Control limits, tolerances, value sets" },
            ].map(({ key, label, required, accept, icon, desc }) => (
              <div key={key} style={{ marginBottom: 14 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                  <span>{icon}</span>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{label}</span>
                  <span style={{ background: required ? "#fef2f2" : "#f0fdf4", color: required ? "#dc2626" : "#16a34a", fontSize: 10, padding: "2px 7px", borderRadius: 10, fontWeight: 600 }}>{required ? "Required" : "Optional"}</span>
                </div>
                <div onClick={() => fileRefs[key].current?.click()} style={{ border: `2px dashed ${files[key] ? "#3b82f6" : "#cbd5e1"}`, borderRadius: 9, padding: "10px 14px", cursor: "pointer", background: files[key] ? "#eff6ff" : "#f8fafc", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 12, color: files[key] ? "#1d4ed8" : "#94a3b8" }}>{files[key] ? `✓ ${files[key].name}` : desc}</span>
                  <span style={{ fontSize: 11, color: "#64748b", background: "white", padding: "3px 9px", borderRadius: 5, border: "1px solid #e2e8f0" }}>Browse</span>
                </div>
                <input ref={fileRefs[key]} type="file" accept={accept} style={{ display: "none" }} onChange={e => e.target.files[0] && handleFile(key, e.target.files[0])} />
              </div>
            ))}

            {error && <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "10px 14px", color: "#dc2626", fontSize: 12, marginBottom: 14 }}>⚠️ {error}</div>}

            <button onClick={analyzePFMEA} disabled={analyzing || !files.pfmea}
              style={{ width: "100%", padding: 14, background: analyzing || !files.pfmea ? "#94a3b8" : "linear-gradient(135deg,#1d4ed8,#3b82f6)", color: "white", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: analyzing || !files.pfmea ? "not-allowed" : "pointer" }}>
              {analyzing ? "🤖 Analyzing..." : "🚀 Analyze PFMEA & Generate Control Plan Draft"}
            </button>

            {analyzing && (
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 12, color: "#64748b", marginBottom: 8, textAlign: "center" }}>{analyzeProgress.status}</div>
                <div style={{ height: 6, background: "#e2e8f0", borderRadius: 3, overflow: "hidden" }}>
                  <div style={{ height: "100%", background: "#3b82f6", borderRadius: 3, width: analyzeProgress.total ? `${(analyzeProgress.current / analyzeProgress.total) * 100}%` : "20%", transition: "width 0.5s ease" }} />
                </div>
                {analyzeProgress.total > 0 && (
                  <div style={{ fontSize: 11, color: "#94a3b8", textAlign: "center", marginTop: 4 }}>Batch {analyzeProgress.current} of {analyzeProgress.total}</div>
                )}
              </div>
            )}

            <div style={{ marginTop: 20, background: "#f8fafc", borderRadius: 8, padding: "12px 16px", fontSize: 12, color: "#64748b" }}>
              <div style={{ fontWeight: 600, marginBottom: 6, color: "#475569" }}>💡 Tips for best results:</div>
              <div>• PFMEA CSV must have headers: PFMEA_ID, Process_Step_Name, Failure_Mode, Severity_S, Occurrence_O, Detection_D, Action_Priority_AP, SC_CC_Flag</div>
              <div style={{ marginTop: 4 }}>• Use the demo CSV provided to test the full workflow first</div>
            </div>
          </div>
        </div>
      )}

      {/* ── CP STAGE ── */}
      {(stage === "cp" || stage === "released") && (
        <div style={{ display: "flex", height: "calc(100vh - 62px)" }}>

          {/* Left — Table */}
          <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>

            {/* Stats + controls */}
            <div style={{ background: "white", borderBottom: "1px solid #e2e8f0", padding: "10px 18px", display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}>
              {[["Total", stats.total, "#1e293b"], ["CC ▼", stats.cc, "#dc2626"], ["SC ◆", stats.sc, "#d97706"], ["Approved", stats.approved, "#10b981"], ["Pending", stats.pending, "#f59e0b"]].map(([l, v, c]) => (
                <div key={l} style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
                  <span style={{ fontSize: 20, fontWeight: 800, color: c }}>{v}</span>
                  <span style={{ fontSize: 11, color: "#94a3b8" }}>{l}</span>
                </div>
              ))}
              <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
                <select value={filterClass} onChange={e => setFilterClass(e.target.value)} style={{ fontSize: 12, padding: "4px 8px", border: "1px solid #e2e8f0", borderRadius: 6 }}>
                  <option value="ALL">All Classes</option>
                  <option value="CC">CC ▼</option>
                  <option value="SC">SC ◆</option>
                  <option value="blank">Standard</option>
                </select>
                <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={{ fontSize: 12, padding: "4px 8px", border: "1px solid #e2e8f0", borderRadius: 6 }}>
                  <option value="ALL">All Status</option>
                  {Object.entries(STATUS_CONFIG).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
                <button onClick={exportCSV} style={{ fontSize: 12, padding: "5px 12px", background: "#0f172a", color: "white", border: "none", borderRadius: 6, cursor: "pointer" }}>⬇ Export CSV</button>
                {stage === "cp" && (
                  <button onClick={releaseCP} style={{ fontSize: 12, padding: "5px 12px", background: "#6d28d9", color: "white", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 700 }}>🔒 Release CP</button>
                )}
              </div>
            </div>

            {error && <div style={{ background: "#fef2f2", padding: "8px 18px", color: "#dc2626", fontSize: 12, borderBottom: "1px solid #fecaca" }}>⚠️ {error}</div>}

            {/* Table */}
            <div style={{ flex: 1, overflow: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ background: "#0f172a", color: "white", position: "sticky", top: 0, zIndex: 10 }}>
                    {["ID","Process Step","Product Characteristic","Process Characteristic","Class","Spec","Control Method","Sample","AP","S/O/D","Status","Actions"].map(h => (
                      <th key={h} style={{ padding: "9px 10px", textAlign: "left", fontWeight: 600, fontSize: 11, whiteSpace: "nowrap", borderRight: "1px solid #1e3a5f" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.length === 0 && (
                    <tr><td colSpan={12} style={{ textAlign: "center", padding: 40, color: "#94a3b8", fontSize: 13 }}>No rows match current filter.</td></tr>
                  )}
                  {filteredRows.map((row, idx) => {
                    const cls = CLASS_CONFIG[row.classification] || CLASS_CONFIG["blank"];
                    const sts = STATUS_CONFIG[row.review_status] || STATUS_CONFIG["PENDING"];
                    const isSel = selectedRow === row.id;
                    return (
                      <tr key={row.id} onClick={() => setSelectedRow(isSel ? null : row.id)}
                        style={{ background: isSel ? "#eff6ff" : idx % 2 === 0 ? "white" : "#f8fafc", cursor: "pointer", borderBottom: "1px solid #e2e8f0" }}>
                        <td style={{ padding: "7px 10px", fontWeight: 700, color: "#3b82f6", whiteSpace: "nowrap" }}>{row.id}</td>
                        <td style={{ padding: "7px 10px", maxWidth: 110 }}>
                          <div style={{ fontWeight: 600, color: "#1e293b", fontSize: 11 }}>{row.process_step}</div>
                          <div style={{ color: "#94a3b8", fontSize: 10 }}>{row.process_step_no}</div>
                        </td>
                        <td style={{ padding: "7px 10px", maxWidth: 130, fontSize: 11, color: "#374151" }}>{row.product_characteristic}</td>
                        <td style={{ padding: "7px 10px", maxWidth: 130, fontSize: 11, color: "#374151" }}>{row.process_characteristic}</td>
                        <td style={{ padding: "7px 10px", textAlign: "center" }}>
                          <span style={{ background: cls.bg, color: cls.color, padding: "2px 8px", borderRadius: 12, fontWeight: 700, fontSize: 14 }}>{cls.symbol}</span>
                        </td>
                        <td style={{ padding: "7px 10px", fontSize: 11 }}>
                          <div style={{ fontWeight: 600 }}>{row.spec_value}</div>
                          <div style={{ color: "#94a3b8", fontSize: 10 }}>{row.spec_unit}</div>
                        </td>
                        <td style={{ padding: "7px 10px", maxWidth: 140, fontSize: 11 }}>{row.control_method}</td>
                        <td style={{ padding: "7px 10px", fontSize: 11, whiteSpace: "nowrap" }}>{row.sample_size}</td>
                        <td style={{ padding: "7px 10px", textAlign: "center" }}>
                          <span style={{ background: row.ap_score === "H" ? "#fef2f2" : row.ap_score === "M" ? "#fffbeb" : "#f0fdf4", color: row.ap_score === "H" ? "#dc2626" : row.ap_score === "M" ? "#d97706" : "#16a34a", fontWeight: 700, padding: "2px 7px", borderRadius: 8, fontSize: 12 }}>{row.ap_score}</span>
                        </td>
                        <td style={{ padding: "7px 10px", fontSize: 11, whiteSpace: "nowrap", color: "#64748b" }}>{row.severity}/{row.occurrence}/{row.detection}</td>
                        <td style={{ padding: "7px 10px" }}>
                          <span style={{ background: sts.bg, color: sts.color, padding: "2px 8px", borderRadius: 10, fontSize: 10, fontWeight: 600, whiteSpace: "nowrap" }}>{sts.label}</span>
                          {(row.discussion || []).length > 0 && <span style={{ marginLeft: 4, fontSize: 10, color: "#3b82f6" }}>💬{row.discussion.length}</span>}
                        </td>
                        <td style={{ padding: "7px 10px", whiteSpace: "nowrap" }}>
                          {stage !== "released" ? (
                            <div style={{ display: "flex", gap: 3 }}>
                              <button onClick={e => { e.stopPropagation(); setInReview(row.id); }} style={{ fontSize: 10, padding: "2px 5px", background: "#dbeafe", color: "#1d4ed8", border: "none", borderRadius: 4, cursor: "pointer" }}>Review</button>
                              <button onClick={e => { e.stopPropagation(); approveRow(row.id); }} style={{ fontSize: 10, padding: "2px 5px", background: "#d1fae5", color: "#065f46", border: "none", borderRadius: 4, cursor: "pointer" }}>✓</button>
                              <button onClick={e => { e.stopPropagation(); rejectRow(row.id); }} style={{ fontSize: 10, padding: "2px 5px", background: "#fee2e2", color: "#991b1b", border: "none", borderRadius: 4, cursor: "pointer" }}>✗</button>
                            </div>
                          ) : <span style={{ fontSize: 10, color: "#6d28d9" }}>🔒</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Right — Detail Panel */}
          {sel && (
            <div style={{ width: 420, background: "white", borderLeft: "1px solid #e2e8f0", display: "flex", flexDirection: "column", overflow: "hidden" }}>
              <div style={{ padding: "14px 18px", borderBottom: "1px solid #e2e8f0", background: "#f8fafc" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 14, color: "#0f172a" }}>{sel.id} · {sel.process_step}</div>
                    <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>{sel.product_characteristic}</div>
                  </div>
                  <button onClick={() => setSelectedRow(null)} style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "#94a3b8", padding: 0 }}>✕</button>
                </div>
                <div style={{ display: "flex", gap: 5, marginTop: 10 }}>
                  {["cp","rationale","discussion","history"].map(t => (
                    <button key={t} onClick={() => setActiveTab(t)} style={{ fontSize: 11, padding: "4px 10px", borderRadius: 6, border: "none", cursor: "pointer", background: activeTab === t ? "#0f172a" : "#e2e8f0", color: activeTab === t ? "white" : "#64748b", fontWeight: activeTab === t ? 700 : 400 }}>
                      {t === "cp" ? "CP Fields" : t === "rationale" ? "AI Rationale" : t === "discussion" ? `Discussion${(sel.discussion||[]).length ? ` (${sel.discussion.length})` : ""}` : "Rev. History"}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ flex: 1, overflow: "auto", padding: "14px 18px" }}>

                {/* CP Fields */}
                {activeTab === "cp" && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
                    {[
                      { label: "Process Step No.", field: "process_step_no" },
                      { label: "Product Characteristic", field: "product_characteristic" },
                      { label: "Process Characteristic", field: "process_characteristic" },
                      { label: "Spec Value", field: "spec_value" },
                      { label: "Spec Unit", field: "spec_unit" },
                      { label: "Control Method", field: "control_method" },
                      { label: "Measurement Device", field: "measurement_device" },
                      { label: "Sample Size", field: "sample_size" },
                      { label: "Sample Frequency", field: "sample_frequency" },
                      { label: "Reaction Plan", field: "reaction_plan", multiline: true },
                      { label: "Responsible", field: "responsible" },
                    ].map(({ label, field, multiline }) => (
                      <div key={field}>
                        <label style={{ fontSize: 10, fontWeight: 700, color: "#64748b", display: "block", marginBottom: 3, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</label>
                        {stage === "released" ? (
                          <div style={{ fontSize: 12, color: "#1e293b", background: "#f8fafc", padding: "7px 9px", borderRadius: 5, border: "1px solid #e2e8f0" }}>{sel[field] || "—"}</div>
                        ) : multiline ? (
                          <textarea value={sel[field] || ""} onChange={e => updateRow(sel.id, field, e.target.value)} rows={3} style={{ width: "100%", fontSize: 12, padding: "7px 9px", border: "1px solid #e2e8f0", borderRadius: 5, resize: "vertical", fontFamily: "inherit", boxSizing: "border-box" }} />
                        ) : (
                          <input value={sel[field] || ""} onChange={e => updateRow(sel.id, field, e.target.value)} style={{ width: "100%", fontSize: 12, padding: "7px 9px", border: "1px solid #e2e8f0", borderRadius: 5, fontFamily: "inherit", boxSizing: "border-box" }} />
                        )}
                      </div>
                    ))}
                    <div>
                      <label style={{ fontSize: 10, fontWeight: 700, color: "#64748b", display: "block", marginBottom: 3, textTransform: "uppercase", letterSpacing: 0.5 }}>Classification</label>
                      {stage === "released" ? (
                        <div style={{ fontWeight: 700, color: CLASS_CONFIG[sel.classification]?.color }}>{sel.classification_symbol} {sel.classification}</div>
                      ) : (
                        <select value={sel.classification} onChange={e => { updateRow(sel.id, "classification", e.target.value); updateRow(sel.id, "classification_symbol", CLASS_CONFIG[e.target.value]?.symbol || "—"); }} style={{ width: "100%", fontSize: 12, padding: "7px 9px", border: "1px solid #e2e8f0", borderRadius: 5 }}>
                          <option value="CC">CC ▼ — Critical Characteristic</option>
                          <option value="SC">SC ◆ — Significant Characteristic</option>
                          <option value="blank">— Standard (no special classification)</option>
                        </select>
                      )}
                    </div>
                    {stage !== "released" && (
                      <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                        <button onClick={() => approveRow(sel.id)} style={{ flex: 1, padding: 10, background: "#10b981", color: "white", border: "none", borderRadius: 7, fontWeight: 700, cursor: "pointer", fontSize: 13 }}>✓ Approve Row</button>
                        <button onClick={() => rejectRow(sel.id)} style={{ flex: 1, padding: 10, background: "#ef4444", color: "white", border: "none", borderRadius: 7, fontWeight: 700, cursor: "pointer", fontSize: 13 }}>✗ Needs Rework</button>
                      </div>
                    )}
                  </div>
                )}

                {/* AI Rationale */}
                {activeTab === "rationale" && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    <div style={{ background: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: 9, padding: 13 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: "#0369a1", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 7 }}>🤖 Why Selected for CP</div>
                      <div style={{ fontSize: 13, color: "#1e293b", lineHeight: 1.6 }}>{sel.selection_rationale || "—"}</div>
                    </div>
                    <div style={{ background: sel.classification === "CC" ? "#fef2f2" : sel.classification === "SC" ? "#fffbeb" : "#f9fafb", border: `1px solid ${sel.classification === "CC" ? "#fecaca" : sel.classification === "SC" ? "#fde68a" : "#e2e8f0"}`, borderRadius: 9, padding: 13 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: sel.classification === "CC" ? "#dc2626" : sel.classification === "SC" ? "#d97706" : "#64748b", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 7 }}>{sel.classification_symbol} Classification Rationale</div>
                      <div style={{ fontSize: 13, color: "#1e293b", lineHeight: 1.6 }}>{sel.classification_rationale || "—"}</div>
                    </div>
                    <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 9, padding: 13 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10 }}>PFMEA Source Data</div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 10 }}>
                        {[["Severity", sel.severity], ["Occurrence", sel.occurrence], ["Detection", sel.detection]].map(([l, v]) => (
                          <div key={l} style={{ textAlign: "center", background: "white", borderRadius: 6, padding: "8px 4px", border: "1px solid #e2e8f0" }}>
                            <div style={{ fontSize: 22, fontWeight: 800, color: "#0f172a" }}>{v}</div>
                            <div style={{ fontSize: 10, color: "#94a3b8" }}>{l}</div>
                          </div>
                        ))}
                      </div>
                      <div style={{ fontSize: 12, color: "#475569", lineHeight: 1.8 }}>
                        <div>Function ID: <strong>{sel.pfmea_function_id}</strong></div>
                        <div>Failure Mode: <strong>{sel.failure_mode}</strong></div>
                        <div>Effect: {sel.failure_effect}</div>
                      </div>
                      <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
                        <span style={{ background: sel.ap_score === "H" ? "#fef2f2" : sel.ap_score === "M" ? "#fffbeb" : "#f0fdf4", color: sel.ap_score === "H" ? "#dc2626" : sel.ap_score === "M" ? "#d97706" : "#16a34a", fontWeight: 700, padding: "3px 10px", borderRadius: 8, fontSize: 13 }}>AP: {sel.ap_score}</span>
                        <span style={{ background: "#f1f5f9", color: "#475569", padding: "3px 10px", borderRadius: 8, fontSize: 12 }}>Confidence: {Math.round((sel.confidence || 0.85) * 100)}%</span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Discussion */}
                {activeTab === "discussion" && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {!(sel.discussion?.length) && <div style={{ textAlign: "center", color: "#94a3b8", fontSize: 13, padding: "20px 0" }}>No comments yet. Add your team's feedback below.</div>}
                    {(sel.discussion || []).map(d => (
                      <div key={d.id} style={{ background: "#f8fafc", borderRadius: 7, padding: 11, border: "1px solid #e2e8f0" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                          <span style={{ fontWeight: 700, fontSize: 12 }}>{d.author}</span>
                          <span style={{ fontSize: 10, color: "#94a3b8" }}>{d.date}</span>
                        </div>
                        <div style={{ fontSize: 13, color: "#374151", lineHeight: 1.5 }}>{d.text}</div>
                      </div>
                    ))}
                    {stage !== "released" && (
                      <div style={{ marginTop: 6 }}>
                        <textarea value={discussionInput} onChange={e => setDiscussionInput(e.target.value)} placeholder="Add a comment, question, or correction for this CP row..." rows={3}
                          style={{ width: "100%", fontSize: 12, padding: 9, border: "1px solid #e2e8f0", borderRadius: 7, fontFamily: "inherit", resize: "vertical", boxSizing: "border-box" }} />
                        <button onClick={() => addDiscussion(sel.id, discussionInput)} style={{ marginTop: 7, padding: "8px 16px", background: "#0f172a", color: "white", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>Add Comment</button>
                      </div>
                    )}
                  </div>
                )}

                {/* Revision History */}
                {activeTab === "history" && (
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 13, color: "#0f172a", marginBottom: 14 }}>CP Revision History</div>
                    {revisionHistory.length === 0 && <div style={{ color: "#94a3b8", fontSize: 13 }}>No revisions yet.</div>}
                    {revisionHistory.map((h, i) => (
                      <div key={i} style={{ display: "flex", gap: 12, marginBottom: 16 }}>
                        <div style={{ width: 30, height: 30, background: i === revisionHistory.length - 1 ? "#0f172a" : "#e2e8f0", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: i === revisionHistory.length - 1 ? "white" : "#64748b", flexShrink: 0 }}>{h.revision}</div>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 13 }}>{h.action}</div>
                          <div style={{ fontSize: 11, color: "#94a3b8" }}>{h.date} · {h.by}</div>
                          <div style={{ fontSize: 11, color: "#64748b" }}>{h.rowCount} CP rows</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {stage === "released" && !selectedRow && (
        <div style={{ position: "fixed", bottom: 24, right: 24, background: "#6d28d9", color: "white", padding: "12px 20px", borderRadius: 12, fontSize: 13, fontWeight: 600, boxShadow: "0 4px 20px rgba(109,40,217,0.4)" }}>
          🔒 Control Plan Released — Rev. {cpMeta.revision} · All rows frozen
        </div>
      )}

      <style>{`* { box-sizing: border-box; } ::-webkit-scrollbar { width:5px; height:5px; } ::-webkit-scrollbar-thumb { background:#cbd5e1; border-radius:3px; } button:hover { opacity:0.88; }`}</style>
    </div>
  );
}
