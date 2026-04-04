# Filing Operations Toolkit — Architecture & Module Plan

> **Date:** March 31, 2026
> **Status:** Architecture finalized, Module A+B implementation next

## Vision

Replace the Excel-based file assignment and finance tracking with a modular Filing Operations Toolkit. Each module is independently useful but shares the same database, auth, and UI shell.

## Tech Stack (Confirmed)

- **Backend:** Node.js + Express.js (same as current)
- **Database:** SQLite via better-sqlite3
- **Frontend:** Vanilla HTML/CSS/JavaScript (no framework)
- **Auth:** Session-based with bcryptjs
- **ImmFile:** Stays separate (Python/FastAPI), integrate via API later

## Module Map

### Module A: Case Management & Workflow ← NEXT
- Brief KT form (counsellor intake — name, type, fee, notes, urgency)
- Manager assignment queue (unassigned cases)
- Staff "My Files" view (only their cases, priority-sorted)
- Priority levels (High / Medium / Low)
- SLA timers per case type (expected days to complete)
- Overdue alerts
- Case lifecycle stages

### Module B: Finance Tracker ← NEXT (with A)
- Fee setup on case creation (application fee + processing fee)
- Installment plans (up to 4 payments)
- Payment recording (amount, date, method)
- Due/balance auto-calculation
- Aging report (overdue payments)
- Revenue dashboard
- CRM reminder flag

### Module C: Document Collection (BUILT — enhance later)
- Auto-generated checklists (11 case types) ✅
- Client portal with doc checklist ✅
- Staff review & accept/reject ✅
- TODO: Client personal info form (in portal)
- TODO: Client data collection (passport, education, work history)

### Module D: File Assembly — ImmFile (SEPARATE)
- AI document classification, data extraction, package assembly
- Python/FastAPI at: RP Immi - Automation - Filing/immfile/
- Integrate via API when ready

### Module E: Reporting & Intelligence (FUTURE)
- Staff performance, case analytics, AI features

## Case Lifecycle

```
New → Assigned → In Progress → Docs Complete → Filing → Submitted
                                                           ↓
                                              In Process → Approved
                                                        → Refused
                                                        → Withdrawn
```

## Role-Based Views

| Role | View | Access |
|------|------|--------|
| Admin/Manager | Full dashboard — all cases, all staff, financials, assignment queue | Everything |
| Filing Staff | "My Files" — their assigned cases only, focused workspace | Own cases, can't assign |
| Counsellor (Sales) | Brief KT form, read-only progress on their submitted cases | Submit KT, view own cases |
| Client | Portal — document checklist, personal info form, progress | Token-based, no login |

## Database Schema (Module A+B additions)

### Modified: `cases` table
```sql
ALTER TABLE cases ADD COLUMN priority TEXT DEFAULT 'medium';
ALTER TABLE cases ADD COLUMN urgency_reason TEXT;
ALTER TABLE cases ADD COLUMN sla_deadline DATE;
ALTER TABLE cases ADD COLUMN stage TEXT DEFAULT 'new';
ALTER TABLE cases ADD COLUMN submitted_at DATETIME;
ALTER TABLE cases ADD COLUMN decision TEXT;
ALTER TABLE cases ADD COLUMN decision_date DATE;
ALTER TABLE cases ADD COLUMN application_number TEXT;
ALTER TABLE cases ADD COLUMN crm_added INTEGER DEFAULT 0;
```

### New: `case_fees` table
```sql
CREATE TABLE IF NOT EXISTS case_fees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL,
  fee_type TEXT NOT NULL,          -- 'application', 'processing', 'government', 'other'
  amount REAL NOT NULL,
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (case_id) REFERENCES cases(id)
);
```

### New: `case_payments` table
```sql
CREATE TABLE IF NOT EXISTS case_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  payment_date DATE NOT NULL,
  payment_method TEXT,             -- 'cash', 'card', 'e-transfer', 'cheque'
  installment_number INTEGER,
  notes TEXT,
  recorded_by INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (case_id) REFERENCES cases(id),
  FOREIGN KEY (recorded_by) REFERENCES users(id)
);
```

### New: `sla_config` table
```sql
CREATE TABLE IF NOT EXISTS sla_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_type_id INTEGER NOT NULL,
  expected_days INTEGER NOT NULL,  -- normal completion time
  warning_days INTEGER NOT NULL,   -- alert X days before SLA breach
  FOREIGN KEY (case_type_id) REFERENCES case_types(id)
);
```

### New: `notifications` table
```sql
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  case_id INTEGER,
  type TEXT NOT NULL,              -- 'assignment', 'overdue', 'payment_due', 'status_change'
  message TEXT NOT NULL,
  is_read INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (case_id) REFERENCES cases(id)
);
```

## API Endpoints (Module A+B)

### Case Management
- `GET /api/cases/queue` — Unassigned cases (manager view)
- `PUT /api/cases/:id/assign` — Assign case to staff member
- `PUT /api/cases/:id/stage` — Update case stage
- `PUT /api/cases/:id/priority` — Set priority
- `GET /api/cases/my` — Current user's assigned cases
- `GET /api/workload` — Staff workload summary

### Finance
- `POST /api/cases/:id/fees` — Add fee to case
- `GET /api/cases/:id/fees` — Get fees for case
- `POST /api/cases/:id/payments` — Record payment
- `GET /api/cases/:id/payments` — Get payments for case
- `GET /api/cases/:id/balance` — Get balance summary
- `GET /api/finance/summary` — Revenue dashboard data
- `GET /api/finance/aging` — Overdue payments report

### Notifications
- `GET /api/notifications` — Current user's notifications
- `PUT /api/notifications/:id/read` — Mark as read
- `GET /api/notifications/count` — Unread count

## KT Form (Simplified)

The counsellor's KT form captures only:
1. Client name, email, phone
2. Case type
3. Priority / urgency
4. Processing fee agreed
5. Application fee (govt fee)
6. Deposit paid amount
7. Payment plan notes
8. Brief notes for filing team
9. CRM reminder flag

All detailed information (personal details, passport, education, work history, case-type-specific fields) is collected from the client via the enhanced client portal.

## SLA Defaults (by case type)

| Case Type | Expected Days | Warning At |
|-----------|:------------:|:---------:|
| PGWP | 14 | 10 |
| TRV / Visitor Visa | 14 | 10 |
| Work Permit (Employer-Specific) | 21 | 14 |
| Open Work Permit / Bridging WP | 21 | 14 |
| Study Permit | 21 | 14 |
| LMIA | 30 | 21 |
| Express Entry (FSW/CEC) | 45 | 30 |
| PNP | 45 | 30 |
| Spousal / Family Sponsorship | 60 | 45 |
| Citizenship | 30 | 21 |
| PR Card Renewal | 21 | 14 |

## AI Enhancement Opportunities (Prioritized)

1. **Smart client reminders** — Generate contextual follow-up messages
2. **Payment anomaly detection** — Flag inconsistent fee/payment data
3. **Auto-classify uploaded documents** (ImmFile integration)
4. **Completion prediction** — Based on historical case data
5. **Workload balancer** — Suggest optimal staff assignment
