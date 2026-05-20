# 🔋 Quality Control Plan App
### AI-Powered Control Plan Generation for Li-Ion Battery Cell Production

---

## What This App Does

This tool uses **Claude AI** to automatically analyze a PFMEA and generate a draft **Control Plan** compliant with **AIAG-VDA 2024** standards.

It is designed for Quality Engineers in Li-Ion battery cell manufacturing who want to:
- Eliminate manual CP creation from scratch
- Ensure consistent SC/CC classification based on defined rules
- Maintain a structured review and approval workflow
- Track discussion history per CP row
- Export to Excel / CSV for Teamcenter migration

---

## How It Works — In Simple Terms

```
Upload PFMEA (CSV/XML)
        ↓
Claude AI reads and analyzes
Applies SC/CC rules + Li-Ion triggers + AIAG 2024 AP logic
        ↓
Draft Control Plan is generated
        ↓
Quality Engineers review, edit, comment, approve row by row
        ↓
CP is released and frozen with revision history
        ↓
Export to CSV for Teamcenter / SAP
```

---

## SC / CC Classification Rules Applied

### CC — Critical Characteristic ▼
- Severity = 9 or 10
- AND linked to safety / regulatory requirement
- AND SC/CC flag = YES in PFMEA

### SC — Significant Characteristic ◆
- Severity = 7 or 8
- OR Detection ≥ 7
- OR Influences CC downstream
- OR High variation risk in Li-Ion context

### Li-Ion Always-Include Triggers
Regardless of AP score, these are always included in the CP:
- Thermal runaway related failure modes
- Short circuit / internal short risk
- Electrolyte containment / leakage
- Electrode alignment / overhang
- Moisture ingress (ppm in CDR)
- Formation temperature / voltage profile
- Electrode coating weight
- NMP residual
- Tab welding strength / resistance
- Electrolyte fill volume / weight
- Cell sealing integrity
- Separator integrity / defects

---

## Files in This Repository

```
/src
  App.jsx                    → Main React application (upload, AI analysis, CP table, review workflow)

/demo-data
  demo_pfmea_liion.csv       → Realistic demo PFMEA with 25 entries across 7 process steps
                               Use this to test the app without real company data

/docs
  claude_prompt_template.md  → Full Claude AI system prompt template for PFMEA → CP mapping
                               Use this when building the backend for production use
```

---

## How to Run the App

### Option A — Claude Artifact (Easiest)
Open the `.jsx` file in Claude.ai as an artifact. No setup needed.

### Option B — Local Development
```bash
git clone https://github.com/spusri26-arch/Quality-Control-Plan-app.git
cd Quality-Control-Plan-app
npm install
npm start
```

---

## PFMEA CSV Format Required

Your PFMEA CSV must include these column headers:

| Column | Description |
|---|---|
| `PFMEA_ID` | Unique ID per PFMEA entry |
| `Process_Step_No` | Process step number (e.g. P-010) |
| `Process_Step_Name` | Name of process step |
| `Function_ID` | Function identifier |
| `Process_Function` | What the process is supposed to do |
| `Failure_Mode` | How it can fail |
| `Failure_Effect_Customer` | Impact on customer / product |
| `Failure_Cause` | Root cause of failure |
| `Prevention_Control` | Current prevention controls |
| `Detection_Control` | Current detection controls |
| `Severity_S` | Severity score (1–10) |
| `Occurrence_O` | Occurrence score (1–10) |
| `Detection_D` | Detection score (1–10) |
| `Action_Priority_AP` | AIAG 2024 Action Priority (H/M/L) |
| `SC_CC_Flag` | SC, CC, or blank |
| `Recommended_Action` | Current recommended actions |

---

## Important Notes

- **API Key**: The app uses Claude API. In Claude.ai artifacts, this is handled automatically.
- **Data Privacy**: Never upload real company PFMEA data to external tools. Use demo data for concept validation. Deploy on your company's secure infrastructure for production use.
- **Batch Processing**: The app processes PFMEA in batches of 8 rows to avoid API token limits. For very large PFMEAs (200+ rows), a backend server is required.
- **Temperature = 0**: All Claude API calls use temperature=0 for deterministic, reproducible QA outputs.

---

## Roadmap

- [ ] Backend server for large PFMEA files (200+ rows)
- [ ] SAP change workflow integration (ECR/ECN trigger)
- [ ] Teamcenter PLM connector
- [ ] Multi-language output (DE/EN)
- [ ] Role-based access control (Quality / Stakeholder / Management)
- [ ] Audit trail export for customer PPAP

---

## Standards Reference

- AIAG-VDA FMEA Handbook 2024
- AIAG Control Plan Reference Manual
- VDA 2 — Production Process and Product Approval
- IATF 16949

---

*Built for Quality Engineering · Li-Ion Battery Cell Production · AIAG 2024*
