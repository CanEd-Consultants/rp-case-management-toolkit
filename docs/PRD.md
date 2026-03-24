# Product Requirements Document (PRD)
## RP Immigration Consulting — Case Management Platform

**Version:** 1.0
**Date:** March 24, 2026
**Owner:** Ravi Pula, RP Immigration Consulting

---

## 1. Problem Statement

RP Immigration Consulting's operations suffer from a fragmented handoff between sales and filing teams, and a painful document collection process with clients. Specifically:

- When sales converts a client, the knowledge transfer to the filing team is informal and inconsistent. Critical details get lost — case type nuances, client preferences, deadlines, and special circumstances.
- The filing team must collect a specific set of documents from each client based on their immigration case type. This process currently relies on WhatsApp messages, emails, and phone calls with no centralized tracking.
- Clients frequently claim they have submitted documents that the filing team has not received. Staff ask again, clients get frustrated, and trust erodes.
- There is no single source of truth visible to both staff and clients showing what has been received versus what is still pending.
- Once documents are collected, the package assembly process is manual and error-prone.

These problems result in delayed filings, repeated work, client dissatisfaction, and operational inefficiency.

## 2. Vision

A unified, modular case management platform that provides end-to-end visibility from the moment a client is converted through sales until their filing package is submitted. The platform is built as small, independent systems — each solving a specific pain point — that connect together into a cohesive whole over time.

## 3. Users and Personas

**Sales Team** — Converts clients. Needs a quick, structured way to hand off client information and case details to the filing team. Does not need to manage documents or checklists.

**Filing Team** — Assigned to cases after handoff. Needs to see all their active cases at a glance, manage document checklists per client, track what has been received, flag issues, and ultimately prepare the filing package.

**Admin / Management** — Oversees all operations. Needs visibility into overall case pipeline, team workload, bottleneck identification, and reporting.

**Clients** — Non-technical individuals going through the immigration process. Need a simple, clear view of what documents are required, what has been received, and what is still pending. Should not need to create accounts or learn new software.

## 4. Modules and Requirements

### Module 1: Client Document Checklist System (Phase 1)

**Purpose:** Structured sales-to-filing handoff and transparent document tracking between staff and clients.

**Functional Requirements:**

FR-1.1: Sales team can create a new case using a Knowledge Transfer (KT) form that captures client name, contact information, case type, service details, notes, deadline, and filing team assignment.

FR-1.2: When a case is created, the system automatically generates a document checklist based on the selected case type, using pre-configured templates.

FR-1.3: The system includes templates for all major Canadian immigration case types: LMIA, Open Work Permit, Employer-Specific Work Permit, Express Entry (FSW and CEC), PNP, Spousal/Family Sponsorship, Study Permit, Visitor/Super Visa, Citizenship Application, and PR Card Renewal.

FR-1.4: Filing team can view all active cases in a dashboard with client name, case type, assigned team member, status, document progress (percentage), and creation date.

FR-1.5: Filing team can customize the checklist for any individual case — adding documents, removing documents, and changing required/optional status.

FR-1.6: Each document in a checklist has a status workflow: Pending → Uploaded (client marked as sent) → Under Review → Accepted or Rejected (with note explaining the issue).

FR-1.7: Each case generates a unique portal URL that can be shared with the client. The client opens the URL and sees a branded RP Immigration Consulting page showing their document checklist with real-time status updates.

FR-1.8: Clients can mark documents as "Sent" on their portal (indicating they have shared it via WhatsApp, email, or Google Drive) and can add notes to individual documents.

FR-1.9: When staff rejects a document, the rejection reason is visible to the client on their portal, clearly indicating what action is needed.

FR-1.10: When all required documents for a case are accepted, the case status automatically updates to "Documents Complete."

FR-1.11: All actions are logged in an activity trail for audit purposes — who did what, when, with timestamps.

FR-1.12: Staff accounts are role-based (admin, sales, filing) with password-protected login. Admin can manage team members.

FR-1.13: Dashboard shows aggregate statistics: total cases, active cases, documents complete, on hold, pending documents across all cases, and documents awaiting review.

FR-1.14: Client portal auto-refreshes every 30 seconds to show latest status without manual reload.

**Non-Functional Requirements:**

NFR-1.1: The system must run on a single machine with no external database server or cloud dependencies.

NFR-1.2: The client portal must be mobile-friendly and work on any modern browser.

NFR-1.3: The client portal must be branded with RP Immigration Consulting identity.

NFR-1.4: The system must handle up to 50 concurrent cases without performance degradation.

### Module 2: Document Package Assembly (Phase 2)

**Purpose:** Once all documents are collected and accepted, assemble them into organized filing packages that meet IRCC submission requirements.

**Functional Requirements:**

FR-2.1: Filing team can initiate package assembly for any case with "Documents Complete" status.

FR-2.2: The system organizes documents into the correct order and structure based on the case type's IRCC requirements.

FR-2.3: The system generates a cover page, table of contents, and document index for each package.

FR-2.4: Filing team can review the assembled package before finalizing.

FR-2.5: The system produces the final package as a PDF or organized folder structure ready for submission.

FR-2.6: The package assembly module reads case and document data from Module 1's database, creating a clean data handoff.

### Module 3: Unified Case Management Dashboard (Phase 3)

**Purpose:** Connect all modules into a single operational view with cross-module visibility, reporting, and workflow automation.

**Functional Requirements:**

FR-3.1: Single dashboard view showing the full lifecycle of every case — from sales conversion through document collection through package assembly and submission.

FR-3.2: Pipeline view showing cases at each stage with drag-and-drop status management.

FR-3.3: Team workload view showing how many active cases each filing team member is handling.

FR-3.4: Reporting: average time from case creation to document completion, average time from document completion to package submission, cases by type, overdue cases.

FR-3.5: Automated notifications when cases are overdue, when clients mark documents as sent (staff needs to review), and when all documents are complete.

FR-3.6: Client communication log — track all interactions (when links were shared, when follow-ups were sent).

FR-3.7: Search and filter across all cases by client name, case type, status, assigned team member, and date range.

### Module 4: Client Portal Enhancement (Phase 4)

**Purpose:** Evolve the client portal from a simple checklist view into a full client experience.

**Functional Requirements:**

FR-4.1: Client login system (email-based magic links) replacing unique URL access.

FR-4.2: In-app document upload — clients can upload files directly through the portal instead of sharing via WhatsApp/Drive.

FR-4.3: Messaging system — clients and staff can exchange messages within the portal, reducing reliance on WhatsApp.

FR-4.4: Case timeline — clients see a visual timeline of their case progress from start to expected completion.

FR-4.5: Multi-language support for the client portal.

FR-4.6: Email and/or SMS notifications when document status changes.

## 5. Success Metrics

- Reduction in "did you receive my document?" calls from clients by 80%
- Average document collection time reduced from 3-4 weeks to under 2 weeks
- Zero cases where documents are lost or misattributed
- Filing team can manage 30% more cases with the same headcount
- Client satisfaction scores improve measurably (survey or NPS)

## 6. Out of Scope (for now)

- Integration with IRCC online portal for direct submission
- Payment processing or invoicing
- Integration with Flowlu CRM (future consideration)
- Multi-office / multi-tenant support
- Automated document verification (OCR, expiry date checking)

## 7. Risks and Mitigations

**Risk:** Client adoption — clients may not check the portal regularly.
**Mitigation:** Portal is simple (no login required in Phase 1), and staff can send the link via WhatsApp where clients are already active. Phase 4 adds push notifications.

**Risk:** Data loss — SQLite is file-based with no built-in replication.
**Mitigation:** Implement automated daily backups of the database file. Phase 3 can migrate to PostgreSQL if scale demands it.

**Risk:** Security — unique URLs without authentication could be guessed or shared.
**Mitigation:** Tokens are 48-character cryptographically random hex strings (2^192 possible values). Phase 4 adds proper authentication.

**Risk:** Scope creep — building too much before validating.
**Mitigation:** Phased approach. Each module is independently useful. Ship and use Module 1 before starting Module 2.
