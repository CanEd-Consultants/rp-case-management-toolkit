# Execution Plan — Phased Roadmap
## RP Immigration Consulting — Case Management Platform

**Version:** 1.0
**Date:** March 24, 2026

---

## Philosophy: Build Small, Connect Later

This project follows a modular build approach. Each phase produces a standalone, immediately useful system. Phases are designed so that:

- Each module solves a real, pressing operational problem on its own
- The team starts using and learning from each module before the next is built
- Feedback from real usage shapes the design of subsequent modules
- Modules are connected into a unified platform only after each has been validated independently
- No phase depends on another being "perfect" — good enough and usable beats comprehensive and delayed

---

## Phase 1: Client Document Checklist System
**Status: COMPLETE**
**Timeline: Delivered March 24, 2026**

### What Was Built

A web application with two faces — a staff dashboard for managing cases and tracking documents, and a client portal for transparent checklist visibility.

### Components Delivered

1. **Knowledge Transfer (KT) Form** — Sales team fills out client details, selects case type, adds notes and deadline. Creates a new case in the system.

2. **Auto-Generated Checklists** — 11 immigration case types pre-loaded with complete document templates (LMIA, work permits, Express Entry, PNP, sponsorship, study permit, visitor visa, citizenship, PR renewal). Each with categorized documents and required/optional flags.

3. **Staff Dashboard** — View all cases at a glance with progress bars. Click into any case to see the full checklist, update document statuses, add/remove documents, and view the activity log.

4. **Client Portal** — Branded RP Immigration page accessible via unique URL. Shows the client's checklist with real-time status. Clients can mark documents as sent and add notes.

5. **Document Status Workflow** — Pending → Uploaded → Under Review → Accepted / Rejected (with notes). Auto-completes when all required docs are accepted.

6. **Team Management** — Admin can add/remove staff members with role assignments.

7. **Activity Logging** — Full audit trail of all actions by staff and clients.

### Deployment Tasks (Action Items)

- [ ] Install Node.js on the office machine that will run the server
- [ ] Copy the application folder to the server machine
- [ ] Run `npm install` and `npm start`
- [ ] Change the default admin password immediately after first login
- [ ] Create staff accounts for each team member (sales and filing)
- [ ] Test creating a case, generating a client link, and verifying the client portal
- [ ] Set up a daily backup script for the `data/checklist.db` file
- [ ] If client portal needs external access: deploy to a VPS with a domain and SSL

### Validation Criteria

- [ ] Sales team has created at least 5 real cases using the KT form
- [ ] Filing team has tracked documents for at least 3 active clients
- [ ] At least 2 clients have accessed their portal and found it clear
- [ ] The "did you send the document?" back-and-forth has noticeably reduced
- [ ] Team provides feedback on what's missing or needs improvement

---

## Phase 2: Document Package Assembly
**Status: PLANNED**
**Estimated Timeline: 2-3 weeks after Phase 1 validation**

### Objective

When all documents for a case are collected and accepted, the filing team needs to assemble them into a structured package that meets IRCC requirements. This module automates the organization, cover page generation, and table of contents creation.

### Prerequisites

- Phase 1 deployed and in active use for at least 2 weeks
- At least 2-3 cases have reached "Documents Complete" status
- Feedback from filing team on their current manual packaging process

### Planned Components

1. **Package Initiation** — Filing team clicks "Build Package" on any case with Documents Complete status. System pulls all accepted documents and organizes them.

2. **Case-Type Specific Organization** — Each immigration case type has a defined document order that matches IRCC expectations. The system knows that for an Express Entry FSW application, identity documents come first, then language results, then education, then employment, etc.

3. **Cover Page Generator** — Auto-generates a professional cover page with client name, case type, file number, preparer info, and date.

4. **Document Index / Table of Contents** — Lists every document in the package with page references and status.

5. **Review Interface** — Filing team reviews the assembled package, can reorder items, add cover letters or supporting memos, and finalize.

6. **Export** — Final package exported as an organized PDF or folder structure.

### Integration with Phase 1

- Reads directly from the `cases` and `case_documents` tables
- Adds a "Build Package" button to the case detail page in the staff dashboard
- Adds `packages` and `package_sections` tables to the database
- New API endpoints under `/api/packages/*`
- Case status gains a new value: `packaging` (between `documents_complete` and `completed`)

### Deliverables

- [ ] Package assembly engine with case-type-specific document ordering
- [ ] Cover page and TOC generator
- [ ] Staff review and finalization interface
- [ ] PDF export functionality
- [ ] Integration into existing staff dashboard

---

## Phase 3: Unified Case Management Dashboard
**Status: PLANNED**
**Estimated Timeline: 3-4 weeks after Phase 2 validation**

### Objective

Connect Modules 1 and 2 into a single operational view that provides full pipeline visibility, team workload management, and basic reporting.

### Prerequisites

- Phases 1 and 2 both in active use
- At least 10-15 cases have gone through the full lifecycle (KT → documents → package)
- Clear understanding of reporting needs from management

### Planned Components

1. **Pipeline View** — Visual board showing cases at each stage: New → Collecting Documents → Documents Complete → Packaging → Submitted. Drag-and-drop status management.

2. **Team Workload View** — How many active cases each filing team member is handling. Highlights imbalances.

3. **Reporting Dashboard** — Key metrics tracked over time:
   - Average days from case creation to documents complete
   - Average days from documents complete to package submitted
   - Cases by type (pie chart)
   - Overdue cases (past deadline)
   - Documents pending vs accepted trend

4. **Notification System** — In-app alerts for staff:
   - Client has marked a document as sent (needs review)
   - All documents complete for a case (ready for packaging)
   - Case is approaching deadline
   - Case has been idle for X days (needs follow-up)

5. **Advanced Search and Filtering** — Find cases by client name, case type, status, assigned team member, date range, or any combination.

6. **Daily Automated Backup** — Scheduled database backup to a designated folder or cloud storage.

### Integration

- Extends the existing staff dashboard rather than replacing it
- Adds reporting API endpoints under `/api/reports/*`
- Adds notification tables and API endpoints
- May introduce WebSocket for real-time notification push (optional — polling works fine at this scale)

### Deliverables

- [ ] Pipeline board view with drag-and-drop
- [ ] Team workload dashboard
- [ ] Reporting with charts (cases over time, average processing time, etc.)
- [ ] In-app notification system
- [ ] Advanced search and filter
- [ ] Automated daily backup

---

## Phase 4: Client Portal Enhancement
**Status: FUTURE**
**Estimated Timeline: 4-6 weeks after Phase 3**

### Objective

Transform the client portal from a simple checklist view into a full client experience with authentication, direct document uploads, messaging, and notifications.

### Prerequisites

- Phases 1-3 stable and in daily use
- Client feedback collected on portal experience
- Decision on hosting (VPS with domain and SSL is required for this phase)

### Planned Components

1. **Client Authentication** — Email-based magic links. Client enters their email, receives a one-time login link. More secure than unique URLs, still simple for non-technical users.

2. **Direct Document Upload** — Clients upload files directly through the portal. Files stored on the server or synced to Google Drive. Eliminates the WhatsApp/Drive workaround.

3. **In-Portal Messaging** — Simple chat interface between client and their assigned filing team member. Keeps all communication in one place with a full history.

4. **Case Timeline** — Visual timeline showing the client their case journey: application started, documents being collected, package being prepared, submitted, decision pending.

5. **Email/SMS Notifications** — Automated alerts when document status changes, when a message is received, when the case moves to a new stage.

6. **Multi-Language Support** — Portal available in English, French, Punjabi, Hindi (based on client demographics).

### Deliverables

- [ ] Client login system with magic links
- [ ] File upload interface with Google Drive integration
- [ ] Messaging system between staff and clients
- [ ] Visual case timeline
- [ ] Email notification integration
- [ ] Multi-language support for top 3-4 languages

---

## Phase 5: Operations Intelligence (Future Vision)
**Status: CONCEPT**
**Timeline: After Phase 4 is stable**

### Objective

Add intelligent features that help the business operate more efficiently.

### Concept Components

1. **Document Completeness Predictor** — Based on historical data, predict how long document collection will take for each case type. Flag cases that are behind schedule.

2. **Workload Balancer** — Automatically suggest case assignments based on team member capacity and expertise.

3. **Client Risk Scoring** — Identify cases that are likely to stall (based on pattern of delayed document submissions) and flag them for proactive follow-up.

4. **Template Learning** — When filing team frequently adds the same custom document to a case type, suggest adding it to the template permanently.

5. **Flowlu CRM Integration** — Sync client data between Flowlu (where sales tracks leads) and this platform (where filing tracks cases). Eliminate duplicate data entry.

6. **IRCC Portal Integration** — Explore direct integration with IRCC online portals for status checking or document submission.

---

## Putting It All Together: The Connection Points

The modular approach works because each module is designed with clear inputs and outputs:

```
Phase 1 OUTPUT: Case with status "documents_complete"
         └──> Phase 2 INPUT: Case ID with all accepted documents

Phase 2 OUTPUT: Finalized package with status "submitted"
         └──> Phase 3 INPUT: Full lifecycle data for reporting

Phase 1 + 2 + 3 share the same database, so "connection" is simply:
  - Adding new tables alongside existing ones
  - Adding new API endpoints to the same server
  - Extending the dashboard UI with new views

No data migration. No API integration. No breaking changes.
```

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-24 | Build modular, connect later | Reduces risk, delivers value faster, allows learning from real usage |
| 2026-03-24 | Vanilla JS frontend (no React/Vue) | Team scale doesn't justify framework complexity. Can upgrade later |
| 2026-03-24 | SQLite over PostgreSQL | Zero infrastructure for Phase 1-2. Migrate if scale demands it |
| 2026-03-24 | Token-based client access (no login) | Minimum friction for clients. Login added in Phase 4 |
| 2026-03-24 | WhatsApp/Drive for doc submission (no in-app upload) | Clients already use these channels. In-app upload in Phase 4 |
| 2026-03-24 | Self-hosted over cloud SaaS | Full control, no recurring costs, data stays local |

---

## Risk Register

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Team doesn't adopt the system | High | Medium | Start with one power user. Demonstrate time savings. Make it easier than the current process |
| Database corruption or loss | High | Low | Automated daily backups. Database file can be copied to USB/cloud |
| Client portal link shared with wrong person | Medium | Low | Tokens are cryptographically random. Phase 4 adds proper auth |
| System downtime impacts operations | Medium | Low | App is stateless and restarts in seconds. No external dependencies to fail |
| Scale beyond SQLite capacity | Low | Low | Migration to PostgreSQL is straightforward — standard SQL, same API layer |
| Regulatory requirements for data handling | Medium | Medium | Consult privacy officer. Data stored locally. No third-party cloud storage in Phase 1 |
