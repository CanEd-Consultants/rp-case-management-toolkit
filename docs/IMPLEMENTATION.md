# Implementation Plan
## RP Immigration Consulting — Case Management Platform

**Version:** 1.0
**Date:** March 24, 2026

---

## 1. Architecture Overview

The platform follows a **modular monorepo** pattern — each module is a self-contained application that can run independently, but all modules share the same database and are served from the same Node.js process when deployed together.

```
┌─────────────────────────────────────────────────────────────────┐
│                        BROWSER (CLIENT)                         │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐    │
│  │ Staff Login   │  │ Staff Dash   │  │ Client Portal      │    │
│  │ /staff        │  │ /staff/dash  │  │ /portal/:token     │    │
│  └──────────────┘  └──────────────┘  └────────────────────┘    │
└───────────────────────────┬─────────────────────────────────────┘
                            │ HTTP / REST API
┌───────────────────────────┴─────────────────────────────────────┐
│                     NODE.JS + EXPRESS SERVER                     │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    API LAYER (server.js)                  │   │
│  │                                                          │   │
│  │  /api/auth/*         Authentication & sessions           │   │
│  │  /api/cases/*        Case CRUD + KT form                 │   │
│  │  /api/documents/*    Document status management          │   │
│  │  /api/client/*       Client portal (public, token-auth)  │   │
│  │  /api/stats          Dashboard analytics                 │   │
│  │  /api/packages/*     Package assembly (Phase 2)          │   │
│  │  /api/reports/*      Reporting & analytics (Phase 3)     │   │
│  └──────────────────────────┬───────────────────────────────┘   │
│                              │                                   │
│  ┌──────────────────────────┴───────────────────────────────┐   │
│  │                  DATABASE LAYER (database.js)             │   │
│  │                  sql.js (SQLite in JavaScript)            │   │
│  └──────────────────────────┬───────────────────────────────┘   │
└──────────────────────────────┴──────────────────────────────────┘
                               │
                    ┌──────────┴──────────┐
                    │   data/checklist.db  │
                    │   (SQLite file)      │
                    └─────────────────────┘
```

## 2. Technology Choices and Rationale

| Component | Choice | Why |
|-----------|--------|-----|
| Runtime | Node.js | Universal, runs everywhere, JavaScript full-stack |
| Web framework | Express.js | Minimal, well-understood, no magic |
| Database | SQLite via sql.js | Zero infrastructure, file-based, portable. No database server to install or manage. Sufficient for <50 concurrent users |
| Frontend | Vanilla HTML/CSS/JS | No build step, no framework lock-in, easy to understand and modify. Can be incrementally upgraded to React/Vue later if needed |
| Auth | express-session + bcryptjs | Simple session-based auth. Sufficient for internal staff use. No OAuth complexity for Phase 1 |
| Client access | Cryptographic URL tokens | No login friction for clients. 48-char hex tokens are unforgeable |

**Why not a framework (React/Vue)?** At this scale (under 20 concurrent users, under 10 pages), a framework adds complexity without proportional benefit. The vanilla approach means zero build tooling, instant reload during development, and anyone on the team can read and modify the HTML.

**Why not PostgreSQL/MySQL?** For a team of under 20 staff handling under 50 active cases, SQLite is more than sufficient and eliminates all database administration. If the operation scales to 100+ concurrent users, PostgreSQL migration is straightforward — the SQL is standard and the API layer is database-agnostic.

## 3. Database Schema

### Current Tables (Phase 1)

**users** — Staff accounts with role-based access.
Columns: id, username, password_hash, full_name, role (admin/sales/filing), created_at.

**case_types** — Immigration case categories.
Columns: id, name, description, is_active.

**case_type_documents** — Template checklists per case type. When a new case is created, these rows are copied into case_documents.
Columns: id, case_type_id (FK), document_name, description, is_required, sort_order, category.

**cases** — Individual client cases created from the KT form.
Columns: id, client_token (unique URL key), case_type_id (FK), client_name, client_email, client_phone, service_details, notes, deadline, assigned_to (FK to users), created_by (FK to users), status, created_at, updated_at.

**case_documents** — Actual checklist items for each case, with status tracking.
Columns: id, case_id (FK), document_name, description, category, is_required, sort_order, status, status_note, file_reference, submitted_at, reviewed_at, client_note, created_at, updated_at.

**activity_log** — Audit trail for all actions.
Columns: id, case_id (FK), action, details, performed_by, created_at.

### Phase 2 Additions

**packages** — Assembled document packages.
Columns: id, case_id (FK), package_type, status (draft/review/finalized), created_by (FK), created_at, finalized_at.

**package_sections** — Ordered sections within a package.
Columns: id, package_id (FK), section_name, sort_order, document_ids (JSON array of case_document IDs).

### Phase 3 Additions

**notifications** — System notifications for staff.
Columns: id, user_id (FK), case_id (FK), type, message, is_read, created_at.

**client_messages** — In-portal messaging between staff and clients.
Columns: id, case_id (FK), sender_type (staff/client), sender_id, message, created_at.

### Phase 4 Additions

**client_accounts** — Client authentication (replacing token-only access).
Columns: id, email, magic_link_token, token_expires_at, case_ids (JSON), created_at.

**file_uploads** — Direct file uploads from client portal.
Columns: id, case_document_id (FK), original_filename, stored_path, file_size, mime_type, uploaded_by, uploaded_at.

## 4. API Design Patterns

All APIs follow consistent patterns:

- `GET /api/{resource}` — List with optional query filters
- `GET /api/{resource}/:id` — Single item with related data
- `POST /api/{resource}` — Create new item
- `PUT /api/{resource}/:id` — Partial update (only send changed fields)
- `DELETE /api/{resource}/:id` — Soft or hard delete

**Authentication:** Staff endpoints require active session (checked via `requireAuth` middleware). Client portal endpoints authenticate via URL token — no session required.

**Error handling:** All errors return `{ error: "description" }` with appropriate HTTP status codes (400, 401, 403, 404, 500).

**Activity logging:** All state-changing operations (POST, PUT, DELETE) automatically write to the activity_log table with the action, details, and performer.

## 5. Data Flow Between Modules

The key architectural decision is how data flows from one module to the next:

```
Module 1 (Checklist)         Module 2 (Package Assembly)
┌─────────────────┐         ┌─────────────────────────┐
│ Case created     │         │                         │
│ Docs collected   │────────>│ Read case + documents   │
│ All docs accepted│         │ Organize into package   │
│ Status: complete │         │ Generate cover + TOC    │
└─────────────────┘         │ Output: filing package  │
                            └────────────┬────────────┘
                                         │
                            Module 3 (Unified Dashboard)
                            ┌────────────┴────────────┐
                            │ Shows full pipeline      │
                            │ Cases at every stage     │
                            │ Reporting + analytics    │
                            └─────────────────────────┘
```

**Connection mechanism:** All modules share the same SQLite database. Module 2 reads from the `cases` and `case_documents` tables written by Module 1. Module 3 reads from all tables. No inter-service communication, no message queues, no API calls between modules — just shared database access.

This is the simplest possible integration pattern and is appropriate for a single-server deployment. If the system later needs to scale to microservices, the shared database can be replaced with API calls between services.

## 6. Security Considerations

**Staff authentication:** Passwords hashed with bcryptjs (10 salt rounds). Sessions stored server-side with 24-hour expiry. Role-based access (admin can manage users, sales can create cases, filing can manage documents).

**Client portal security:** Tokens are 48 characters of cryptographically random hex (24 bytes from Node.js crypto.randomBytes). The probability of guessing a valid token is 1 in 2^192 — effectively zero. Tokens are not sequential and cannot be enumerated.

**Input validation:** All user inputs are parameterized in SQL queries (no string concatenation). HTML output is escaped to prevent XSS.

**Data persistence:** SQLite database file auto-saves every 10 seconds and on every write operation. For production use, a daily backup script should be added (Phase 3).

## 7. Deployment Options

**Option A — Local machine (current):** Run `npm start` on any machine with Node.js. Access via `localhost:3000`. Suitable for single-office use where all staff are on the same network.

**Option B — LAN deployment:** Run on one office machine, access from other machines via the host's IP address (e.g., `http://192.168.1.x:3000`). Client portal links use the public IP or a domain.

**Option C — Cloud deployment (recommended for client portal access):** Deploy to a VPS (DigitalOcean, Linode, AWS Lightsail — $5-10/month). Point a domain like `portal.rpimmigration.com`. Use nginx as reverse proxy with SSL (Let's Encrypt). This enables clients to access their portal from anywhere.

**Option D — Docker:** Package as a Docker container for consistent deployment across environments. Docker Compose file with the Node.js app and an nginx reverse proxy.

## 8. File and Folder Conventions

- All source files in the project root and `/public` directories
- Database file in `/data` (gitignored)
- Documentation in `/docs`
- Static assets (images, CSS, JS) in `/public`
- No build step required — all files served directly
- Environment variables via `.env` file (Phase 2+) for secrets and configuration
