# CLAUDE.md — RP Immigration Consulting Case Management System

## Project Overview

This project is a modular case management platform for **RP Immigration Consulting**, designed to streamline the end-to-end workflow from sales conversion through document collection to final package assembly for immigration filings.

The system is being built in phases — small, standalone modules that each solve a real operational pain point, designed to connect into a unified platform over time.

## Business Context

RP Immigration Consulting handles Canadian immigration cases including LMIA, work permits, Express Entry, PNP, spousal/family sponsorship, study permits, visitor visas, citizenship applications, and PR card renewals.

**Core workflow:**
Sales team converts a client → Knowledge Transfer (KT) handoff to filing team → Filing team collects documents from client → Documents are reviewed and accepted → Filing package is assembled and submitted.

**Key problem being solved:** Document collection between staff and clients has been a back-and-forth nightmare — clients claim they sent documents, staff say they haven't received them. There is no single source of truth visible to both parties.

## System Architecture

The platform is composed of independent modules that communicate through shared data structures:

- **Module 1 — Client Document Checklist App** (Phase 1, BUILT): KT form, document checklist with staff dashboard and client portal, document status tracking.
- **Module 2 — Document Package Assembly** (Phase 2, PLANNED): Takes completed document sets and assembles them into organized filing packages per IRCC requirements.
- **Module 3 — Unified Case Management Dashboard** (Phase 3, PLANNED): Connects all modules into a single operational view with reporting, analytics, and workflow automation.
- **Module 4 — Client Portal Enhancement** (Phase 4, FUTURE): Client authentication, direct document uploads, in-portal messaging, case timeline, and notifications.
- **Module 5 — Operations Intelligence** (Phase 5, FUTURE): Predictive analytics, workload balancing, CRM integration, and IRCC portal integration.

## Tech Stack

- **Backend:** Node.js + Express.js
- **Database:** SQLite via sql.js (pure JavaScript, no native compilation needed)
- **Frontend:** Vanilla HTML/CSS/JavaScript (no framework dependency)
- **Authentication:** Session-based with bcryptjs password hashing
- **Hosting:** Self-hosted, runs on any machine with Node.js installed

## Project Structure

```
Client Checklist App/
├── server.js              # Express server, API routes, page serving
├── database.js            # Database initialization, schema, seed data
├── package.json           # Dependencies and scripts
├── data/
│   └── checklist.db       # SQLite database file (auto-created)
├── public/
│   ├── staff/
│   │   ├── login.html     # Staff login page
│   │   └── dashboard.html # Staff dashboard (cases, KT form, checklists)
│   └── client/
│       └── portal.html    # Client-facing checklist portal (branded)
├── docs/                  # Project documentation
│   ├── PRD.md             # Product Requirements Document
│   ├── IMPLEMENTATION.md  # Technical Implementation Plan
│   └── EXECUTION.md       # Phased Execution Roadmap
```

## Running the Application

```bash
cd "Client Checklist App"
npm install
npm start
```

Server starts at `http://localhost:3000`. Staff login at `/staff`, default credentials: `admin` / `admin123`.

## Key API Endpoints

**Authentication:**
- `POST /api/auth/login` — Staff login
- `GET /api/auth/me` — Current session user

**Cases:**
- `GET /api/cases` — List all cases with document progress
- `POST /api/cases` — Create new case (KT form submission)
- `GET /api/cases/:id` — Case detail with documents and activity log
- `PUT /api/cases/:id` — Update case info or status

**Documents:**
- `POST /api/cases/:id/documents` — Add document to checklist
- `PUT /api/documents/:id` — Update document status (staff)
- `DELETE /api/documents/:id` — Remove document from checklist

**Client Portal (public, token-based):**
- `GET /api/client/:token` — Get client's case and checklist
- `PUT /api/client/:token/documents/:docId/mark-sent` — Client marks document as sent
- `PUT /api/client/:token/documents/:docId/note` — Client adds a note

**Dashboard:**
- `GET /api/stats` — Aggregate statistics for dashboard

## Database Schema

Five core tables: `users`, `case_types`, `case_type_documents` (templates), `cases`, `case_documents`, and `activity_log`. The schema supports role-based access (admin, sales, filing), template-driven checklist generation, and full audit trail.

## Design Decisions

1. **Modular-first:** Each module is a standalone app that works independently. Modules share data structure conventions so they can be connected later without rewriting.
2. **No framework frontend:** Vanilla JS keeps the stack simple, avoids build tooling, and makes it easy for non-developers to understand and modify.
3. **Token-based client access:** Clients get a unique URL (no login required). Simple for non-tech-savvy clients. Can be upgraded to email magic links or password login later.
4. **Template-driven checklists:** 11 immigration case types pre-loaded with document templates. Filing team can customize per client.
5. **SQLite:** Zero infrastructure. No database server to manage. File-based, portable, and sufficient for under 50 concurrent users.

## Conventions

- All dates stored as ISO strings in UTC
- API responses use JSON
- Document statuses: `pending` → `uploaded` → `under_review` → `accepted` / `rejected`
- Case statuses: `active` → `documents_complete` → `packaging` (Phase 2) → `completed` / `on_hold`
- Activity log tracks all changes for audit trail
- Client token is a 48-character hex string (24 random bytes)
