const express = require('express');
const session = require('express-session');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { initDatabase, DB_PATH } = require('./database');

// Load .env file if present
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    line = line.trim();
    if (line && !line.startsWith('#')) {
      const [key, ...val] = line.split('=');
      if (key && val.length && !process.env[key.trim()]) {
        process.env[key.trim()] = val.join('=').trim();
      }
    }
  });
}

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

function getSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const secretFile = path.join(__dirname, '.session-secret');
  if (fs.existsSync(secretFile)) return fs.readFileSync(secretFile, 'utf8').trim();
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretFile, secret, { mode: 0o600 });
  return secret;
}

// Middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  if (IS_PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Trust Railway/Render proxy for secure cookies
if (IS_PROD) app.set('trust proxy', 1);

app.use(session({
  secret: getSessionSecret(),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000, httpOnly: true, secure: IS_PROD, sameSite: 'lax' }
}));

let db = null;

// ==================== ROLE HIERARCHY ====================
// admin > team_lead > filing (team member), sales (counsellor)
// admin: full access to everything
// team_lead: can assign/reassign cases, see team stats, manage docs — no finance dashboard, no user management
// filing: see own assigned files only, update docs/stages — no assignment, no admin features
// sales: create cases (KT form), see own created cases progress — read-only after submission

function requireAuth(req, res, next) {
  if (req.session && req.session.user) next();
  else res.status(401).json({ error: 'Unauthorized' });
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) return res.status(401).json({ error: 'Unauthorized' });
    if (roles.includes(req.session.user.role)) next();
    else res.status(403).json({ error: 'Insufficient permissions' });
  };
}

function canAssign(role) { return role === 'admin' || role === 'team_lead'; }
function isAdmin(role) { return role === 'admin'; }

// ==================== AUTH ROUTES ====================

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  req.session.user = { id: user.id, username: user.username, full_name: user.full_name, role: user.role };
  res.json({ success: true, user: req.session.user });
});

app.post('/api/auth/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });

app.get('/api/auth/me', (req, res) => {
  if (req.session && req.session.user) res.json({ user: req.session.user });
  else res.status(401).json({ error: 'Not logged in' });
});

// ==================== USER MANAGEMENT (admin only) ====================

app.get('/api/users', requireAuth, (req, res) => {
  const users = db.prepare('SELECT id, username, full_name, role, sort_order, is_active, created_at FROM users ORDER BY sort_order, id').all();
  res.json(users);
});

app.post('/api/users', requireRole('admin'), (req, res) => {
  const { username, password, full_name, role } = req.body;
  try {
    const hash = bcrypt.hashSync(password, 10);
    const result = db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?, ?, ?, ?)')
      .run(username, hash, full_name, role || 'filing');
    res.json({ id: result.lastInsertRowid, username, full_name, role: role || 'filing' });
  } catch (err) { res.status(400).json({ error: 'Username already exists' }); }
});

app.put('/api/users/:id', requireRole('admin'), (req, res) => {
  const { full_name, role } = req.body;
  const userId = parseInt(req.params.id);
  const fields = [];
  const params = [];
  if (full_name !== undefined) { fields.push('full_name = ?'); params.push(full_name); }
  if (role !== undefined) { fields.push('role = ?'); params.push(role); }
  if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });
  params.push(userId);
  db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json({ success: true });
});

app.put('/api/users/:id/password', requireRole('admin'), (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, parseInt(req.params.id));
  res.json({ success: true });
});

app.put('/api/users/reorder', requireRole('admin'), (req, res) => {
  const { order } = req.body; // array of user IDs in desired order
  if (!Array.isArray(order)) return res.status(400).json({ error: 'Order array required' });
  const stmt = db.prepare('UPDATE users SET sort_order = ? WHERE id = ?');
  order.forEach((id, idx) => stmt.run(idx, id));
  res.json({ success: true });
});

app.delete('/api/users/:id', requireRole('admin'), (req, res) => {
  db.prepare('DELETE FROM users WHERE id = ? AND role != ?').run(parseInt(req.params.id), 'admin');
  res.json({ success: true });
});

// ==================== CASE TYPES ====================

app.get('/api/case-types', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM case_types WHERE is_active = 1').all());
});

app.get('/api/case-types/:id/documents', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM case_type_documents WHERE case_type_id = ? ORDER BY sort_order').all(parseInt(req.params.id)));
});

// ==================== CASES ====================
// IMPORTANT: Specific routes (/queue, /my) MUST come before /:id

app.get('/api/cases/queue', requireAuth, (req, res) => {
  const cases = db.prepare(`
    SELECT c.*, ct.name as case_type_name, u2.full_name as created_by_name
    FROM cases c
    JOIN case_types ct ON c.case_type_id = ct.id
    LEFT JOIN users u2 ON c.created_by = u2.id
    WHERE c.deleted_at IS NULL AND (c.assigned_to IS NULL OR c.stage = 'new')
    ORDER BY CASE c.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, c.created_at ASC
  `).all();
  res.json(cases);
});

app.get('/api/cases/my', requireAuth, (req, res) => {
  const cases = db.prepare(`
    SELECT c.*, ct.name as case_type_name, u1.full_name as assigned_to_name, u2.full_name as created_by_name
    FROM cases c
    JOIN case_types ct ON c.case_type_id = ct.id
    LEFT JOIN users u1 ON c.assigned_to = u1.id
    LEFT JOIN users u2 ON c.created_by = u2.id
    WHERE c.deleted_at IS NULL AND c.assigned_to = ?
    ORDER BY CASE c.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, c.sla_deadline ASC
  `).all(req.session.user.id);

  const enriched = cases.map(c => {
    const docs = db.prepare('SELECT status FROM case_documents WHERE case_id = ?').all(c.id);
    const fees = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM case_fees WHERE case_id = ?').get(c.id).total;
    const paid = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM case_payments WHERE case_id = ?').get(c.id).total;
    return { ...c, total_docs: docs.length, accepted_docs: docs.filter(d => d.status === 'accepted').length,
      pending_docs: docs.filter(d => d.status === 'pending').length, total_fees: fees, total_paid: paid,
      balance_due: fees - paid, is_overdue: c.sla_deadline && new Date(c.sla_deadline) < new Date() };
  });
  res.json(enriched);
});

app.get('/api/cases/my-sales-finance', requireAuth, (req, res) => {
  const cases = db.prepare(`
    SELECT c.id, c.client_name, c.stage, c.priority, c.created_at, ct.name as case_type_name,
           u1.full_name as assigned_to_name,
           COALESCE(f.total_fees, 0) as total_fees,
           COALESCE(p.total_paid, 0) as total_paid,
           COALESCE(f.total_fees, 0) - COALESCE(p.total_paid, 0) as balance_due
    FROM cases c
    JOIN case_types ct ON c.case_type_id = ct.id
    LEFT JOIN users u1 ON c.assigned_to = u1.id
    LEFT JOIN (SELECT case_id, SUM(amount) as total_fees FROM case_fees GROUP BY case_id) f ON f.case_id = c.id
    LEFT JOIN (SELECT case_id, SUM(amount) as total_paid FROM case_payments GROUP BY case_id) p ON p.case_id = c.id
    WHERE c.deleted_at IS NULL AND c.created_by = ?
    ORDER BY c.created_at DESC
  `).all(req.session.user.id);

  const totalFees = cases.reduce((s, c) => s + c.total_fees, 0);
  const totalPaid = cases.reduce((s, c) => s + c.total_paid, 0);
  res.json({ cases, total_fees: totalFees, total_paid: totalPaid, total_due: totalFees - totalPaid });
});

app.get('/api/cases', requireAuth, (req, res) => {
  let query = `
    SELECT c.*, ct.name as case_type_name, u1.full_name as assigned_to_name, u2.full_name as created_by_name
    FROM cases c
    JOIN case_types ct ON c.case_type_id = ct.id
    LEFT JOIN users u1 ON c.assigned_to = u1.id
    LEFT JOIN users u2 ON c.created_by = u2.id
  `;
  const params = [];
  const role = req.session.user.role;
  const showDeleted = req.query.show_deleted === '1' && isAdmin(role);

  // Base filter: exclude deleted unless admin asks
  let where = showDeleted ? '1=1' : 'c.deleted_at IS NULL';

  // Sales users only see their own created cases
  if (role === 'sales') {
    where += ' AND c.created_by = ?';
    params.push(req.session.user.id);
  }
  // Filing users see only their assigned cases
  else if (role === 'filing') {
    where += ' AND c.assigned_to = ?';
    params.push(req.session.user.id);
  }

  query += ` WHERE ${where} ORDER BY c.created_at DESC`;
  const cases = db.prepare(query).all(...params);

  const enriched = cases.map(c => {
    const docs = db.prepare('SELECT status FROM case_documents WHERE case_id = ?').all(c.id);
    const fees = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM case_fees WHERE case_id = ?').get(c.id).total;
    const paid = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM case_payments WHERE case_id = ?').get(c.id).total;
    return { ...c, total_docs: docs.length, accepted_docs: docs.filter(d => d.status === 'accepted').length,
      rejected_docs: docs.filter(d => d.status === 'rejected').length, pending_docs: docs.filter(d => d.status === 'pending').length,
      total_fees: fees, total_paid: paid, balance_due: fees - paid };
  });
  res.json(enriched);
});

app.get('/api/cases/stale', requireAuth, (req, res) => {
  const cases = db.prepare(`
    SELECT c.id, c.client_name, c.stage, c.priority, c.sla_deadline,
           ct.name as case_type_name, u1.full_name as assigned_to_name,
           MAX(al.created_at) as last_activity
    FROM cases c
    JOIN case_types ct ON c.case_type_id = ct.id
    LEFT JOIN users u1 ON c.assigned_to = u1.id
    LEFT JOIN activity_log al ON al.case_id = c.id
    WHERE c.deleted_at IS NULL AND c.stage NOT IN ('submitted','in_process','approved','refused','withdrawn')
    GROUP BY c.id
    HAVING last_activity < datetime('now', '-7 days') OR last_activity IS NULL
    ORDER BY last_activity ASC
  `).all();
  res.json(cases);
});

app.get('/api/cases/:id', requireAuth, (req, res) => {
  const caseData = db.prepare(`
    SELECT c.*, ct.name as case_type_name, u1.full_name as assigned_to_name, u2.full_name as created_by_name
    FROM cases c
    JOIN case_types ct ON c.case_type_id = ct.id
    LEFT JOIN users u1 ON c.assigned_to = u1.id
    LEFT JOIN users u2 ON c.created_by = u2.id
    WHERE c.id = ?
  `).get(parseInt(req.params.id));

  if (!caseData) return res.status(404).json({ error: 'Case not found' });

  const documents = db.prepare('SELECT * FROM case_documents WHERE case_id = ? ORDER BY sort_order, category').all(parseInt(req.params.id));
  const activity = db.prepare('SELECT * FROM activity_log WHERE case_id = ? ORDER BY created_at DESC').all(parseInt(req.params.id));

  res.json({ ...caseData, documents, activity: activity.slice(0, 50) });
});

app.post('/api/cases', requireAuth, (req, res) => {
  const { case_type_id, client_name, client_email, client_phone, service_details, notes, deadline, assigned_to, kt_data, priority, urgency_reason, fees } = req.body;
  const client_token = crypto.randomBytes(24).toString('hex');

  const sla = db.prepare('SELECT expected_days FROM sla_config WHERE case_type_id = ?').get(parseInt(case_type_id));
  const slaDays = sla ? sla.expected_days : 30;
  const slaDate = new Date();
  slaDate.setDate(slaDate.getDate() + slaDays);
  const sla_deadline = slaDate.toISOString().split('T')[0];

  const createCase = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO cases (case_type_id, client_name, client_email, client_phone, service_details, notes, deadline, assigned_to, created_by, client_token, kt_data, priority, urgency_reason, sla_deadline, stage)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      parseInt(case_type_id), client_name, client_email || '', client_phone || '',
      service_details || '', notes || '', deadline || null,
      assigned_to ? parseInt(assigned_to) : null,
      req.session.user.id, client_token,
      kt_data ? JSON.stringify(kt_data) : '{}',
      priority || 'medium', urgency_reason || '', sla_deadline,
      assigned_to ? 'assigned' : 'new'
    );

    const caseId = result.lastInsertRowid;

    const templateDocs = db.prepare('SELECT * FROM case_type_documents WHERE case_type_id = ? ORDER BY sort_order').all(parseInt(case_type_id));
    for (const doc of templateDocs) {
      db.prepare('INSERT INTO case_documents (case_id, document_name, description, category, is_required, sort_order) VALUES (?, ?, ?, ?, ?, ?)')
        .run(caseId, doc.document_name, doc.description || '', doc.category, doc.is_required, doc.sort_order);
    }

    if (fees && Array.isArray(fees)) {
      fees.forEach(fee => {
        if (fee.amount && fee.fee_type) {
          db.prepare('INSERT INTO case_fees (case_id, fee_type, amount, description) VALUES (?, ?, ?, ?)')
            .run(caseId, fee.fee_type, parseFloat(fee.amount), fee.description || '');
        }
      });
    }

    db.prepare('INSERT INTO activity_log (case_id, action, details, performed_by) VALUES (?, ?, ?, ?)')
      .run(caseId, 'case_created', 'Case created for ' + client_name, req.session.user.full_name);

    if (assigned_to) {
      db.prepare('INSERT INTO notifications (user_id, case_id, type, message) VALUES (?, ?, ?, ?)')
        .run(parseInt(assigned_to), caseId, 'assignment', `New case assigned: ${client_name}`);
    } else {
      // Notify all admin and team_lead users about unassigned case
      const managers = db.prepare("SELECT id FROM users WHERE role IN ('admin', 'team_lead') AND id != ?").all(req.session.user.id);
      managers.forEach(m => {
        db.prepare('INSERT INTO notifications (user_id, case_id, type, message) VALUES (?, ?, ?, ?)')
          .run(m.id, caseId, 'new_case', `New unassigned case: ${client_name} — needs assignment`);
      });
    }

    return { id: caseId, client_token };
  });

  res.json(createCase());
});

app.put('/api/cases/:id', requireAuth, (req, res) => {
  const { status, assigned_to, notes, deadline, client_name, client_email, client_phone, service_details, kt_data,
          priority, urgency_reason, stage, application_number, decision, decision_date, crm_added, sla_deadline, submitted_at, case_type_id } = req.body;
  const fields = [];
  const params = [];
  const caseId = parseInt(req.params.id);
  const role = req.session.user.role;

  // Only admin and team_lead can reassign
  if (assigned_to !== undefined) {
    if (!canAssign(role)) return res.status(403).json({ error: 'Only admin or team lead can reassign cases' });
    fields.push('assigned_to = ?'); params.push(assigned_to ? parseInt(assigned_to) : null);
    if (assigned_to) {
      const c = db.prepare('SELECT client_name FROM cases WHERE id = ?').get(caseId);
      db.prepare('INSERT INTO notifications (user_id, case_id, type, message) VALUES (?, ?, ?, ?)')
        .run(parseInt(assigned_to), caseId, 'assignment', `Case assigned to you: ${c ? c.client_name : 'Unknown'}`);
    }
  }

  if (status !== undefined) { fields.push('status = ?'); params.push(status); }
  if (notes !== undefined) { fields.push('notes = ?'); params.push(notes); }
  if (deadline !== undefined) { fields.push('deadline = ?'); params.push(deadline); }
  if (client_name !== undefined) { fields.push('client_name = ?'); params.push(client_name); }
  if (client_email !== undefined) { fields.push('client_email = ?'); params.push(client_email); }
  if (client_phone !== undefined) { fields.push('client_phone = ?'); params.push(client_phone); }
  if (service_details !== undefined) { fields.push('service_details = ?'); params.push(service_details); }
  if (kt_data !== undefined) { fields.push('kt_data = ?'); params.push(JSON.stringify(kt_data)); }
  if (priority !== undefined) { fields.push('priority = ?'); params.push(priority); }
  if (urgency_reason !== undefined) { fields.push('urgency_reason = ?'); params.push(urgency_reason); }
  if (stage !== undefined) { fields.push('stage = ?'); params.push(stage); }
  if (application_number !== undefined) { fields.push('application_number = ?'); params.push(application_number); }
  if (decision !== undefined) { fields.push('decision = ?'); params.push(decision); }
  if (decision_date !== undefined) { fields.push('decision_date = ?'); params.push(decision_date); }
  if (crm_added !== undefined) { fields.push('crm_added = ?'); params.push(crm_added ? 1 : 0); }
  if (sla_deadline !== undefined) { fields.push('sla_deadline = ?'); params.push(sla_deadline); }
  if (submitted_at !== undefined) { fields.push('submitted_at = ?'); params.push(submitted_at); }
  if (case_type_id !== undefined) {
    // Only admin or case creator can change case type
    const c = db.prepare('SELECT created_by FROM cases WHERE id = ?').get(caseId);
    if (!isAdmin(role) && (!c || c.created_by !== req.session.user.id)) {
      return res.status(403).json({ error: 'Only admin or case creator can change case type' });
    }
    fields.push('case_type_id = ?'); params.push(parseInt(case_type_id));
  }

  if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });

  fields.push("updated_at = datetime('now')");
  params.push(caseId);
  db.prepare(`UPDATE cases SET ${fields.join(', ')} WHERE id = ?`).run(...params);

  db.prepare('INSERT INTO activity_log (case_id, action, details, performed_by) VALUES (?, ?, ?, ?)')
    .run(caseId, 'case_updated', 'Case information updated', req.session.user.full_name);

  res.json({ success: true });
});

// ==================== CASE DOCUMENTS ====================

app.post('/api/cases/:id/documents', requireAuth, (req, res) => {
  const { document_name, description, category, is_required } = req.body;
  const caseId = parseInt(req.params.id);
  const maxOrder = db.prepare('SELECT MAX(sort_order) as max_order FROM case_documents WHERE case_id = ?').get(caseId);
  const result = db.prepare('INSERT INTO case_documents (case_id, document_name, description, category, is_required, sort_order) VALUES (?, ?, ?, ?, ?, ?)')
    .run(caseId, document_name, description || '', category || 'General', is_required !== undefined ? parseInt(is_required) : 1, (maxOrder.max_order || 0) + 1);

  db.prepare('INSERT INTO activity_log (case_id, action, details, performed_by) VALUES (?, ?, ?, ?)')
    .run(caseId, 'document_added', 'Added document: ' + document_name, req.session.user.full_name);

  res.json({ id: result.lastInsertRowid });
});

app.put('/api/documents/:id', requireAuth, (req, res) => {
  const { status, status_note, file_reference } = req.body;
  const docId = parseInt(req.params.id);
  const doc = db.prepare('SELECT * FROM case_documents WHERE id = ?').get(docId);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  const fields = ["updated_at = datetime('now')"];
  const params = [];

  if (status !== undefined) {
    fields.push('status = ?'); params.push(status);
    if (status === 'accepted' || status === 'rejected') fields.push("reviewed_at = datetime('now')");
    if (status === 'uploaded') fields.push("submitted_at = datetime('now')");
  }
  if (status_note !== undefined) { fields.push('status_note = ?'); params.push(status_note); }
  if (file_reference !== undefined) { fields.push('file_reference = ?'); params.push(file_reference); }

  params.push(docId);
  db.prepare(`UPDATE case_documents SET ${fields.join(', ')} WHERE id = ?`).run(...params);

  db.prepare('INSERT INTO activity_log (case_id, action, details, performed_by) VALUES (?, ?, ?, ?)')
    .run(doc.case_id, 'document_status_changed',
      doc.document_name + ': ' + (status || 'updated') + (status_note ? ' - ' + status_note : ''),
      req.session.user.full_name);

  if (status === 'accepted') {
    const pending = db.prepare("SELECT COUNT(*) as count FROM case_documents WHERE case_id = ? AND is_required = 1 AND status != 'accepted'").get(doc.case_id);
    if (pending.count === 0) {
      db.prepare("UPDATE cases SET status = 'documents_complete', stage = 'docs_complete', updated_at = datetime('now') WHERE id = ?").run(doc.case_id);
      db.prepare('INSERT INTO activity_log (case_id, action, details, performed_by) VALUES (?, ?, ?, ?)')
        .run(doc.case_id, 'all_documents_complete', 'All required documents have been accepted', 'System');
    }
  }

  res.json({ success: true });
});

app.delete('/api/documents/:id', requireAuth, (req, res) => {
  const docId = parseInt(req.params.id);
  const doc = db.prepare('SELECT * FROM case_documents WHERE id = ?').get(docId);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  db.prepare('DELETE FROM case_documents WHERE id = ?').run(docId);
  db.prepare('INSERT INTO activity_log (case_id, action, details, performed_by) VALUES (?, ?, ?, ?)')
    .run(doc.case_id, 'document_removed', 'Removed document: ' + doc.document_name, req.session.user.full_name);
  res.json({ success: true });
});

// ==================== CLIENT PORTAL ====================

app.get('/api/client/:token', (req, res) => {
  const caseData = db.prepare(`
    SELECT c.id, c.client_name, c.client_token, c.status, c.deadline, ct.name as case_type_name, u1.full_name as assigned_to_name
    FROM cases c JOIN case_types ct ON c.case_type_id = ct.id LEFT JOIN users u1 ON c.assigned_to = u1.id
    WHERE c.client_token = ?
  `).get(req.params.token);
  if (!caseData) return res.status(404).json({ error: 'Case not found' });
  const documents = db.prepare('SELECT id, document_name, description, category, is_required, status, status_note, client_note, submitted_at, reviewed_at, sort_order FROM case_documents WHERE case_id = ? ORDER BY sort_order, category').all(caseData.id);
  res.json({ ...caseData, documents });
});

app.put('/api/client/:token/documents/:docId/note', (req, res) => {
  const caseData = db.prepare('SELECT id FROM cases WHERE client_token = ?').get(req.params.token);
  if (!caseData) return res.status(404).json({ error: 'Case not found' });
  const docId = parseInt(req.params.docId);
  const doc = db.prepare('SELECT * FROM case_documents WHERE id = ? AND case_id = ?').get(docId, caseData.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  db.prepare("UPDATE case_documents SET client_note = ?, updated_at = datetime('now') WHERE id = ?").run(req.body.client_note, docId);
  db.prepare('INSERT INTO activity_log (case_id, action, details, performed_by) VALUES (?, ?, ?, ?)').run(caseData.id, 'client_note_added', 'Client note on ' + doc.document_name, 'Client');
  res.json({ success: true });
});

app.put('/api/client/:token/documents/:docId/mark-sent', (req, res) => {
  const caseData = db.prepare('SELECT id FROM cases WHERE client_token = ?').get(req.params.token);
  if (!caseData) return res.status(404).json({ error: 'Case not found' });
  const docId = parseInt(req.params.docId);
  const doc = db.prepare('SELECT * FROM case_documents WHERE id = ? AND case_id = ?').get(docId, caseData.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  if (doc.status !== 'pending' && doc.status !== 'rejected') return res.status(400).json({ error: 'Cannot mark as sent in current status' });
  db.prepare("UPDATE case_documents SET status = 'uploaded', client_note = ?, submitted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
    .run(req.body.client_note || doc.client_note || '', docId);
  db.prepare('INSERT INTO activity_log (case_id, action, details, performed_by) VALUES (?, ?, ?, ?)').run(caseData.id, 'client_marked_sent', 'Client marked "' + doc.document_name + '" as sent', 'Client');
  res.json({ success: true });
});

// Client personal info
app.get('/api/client/:token/info', (req, res) => {
  const c = db.prepare('SELECT client_data FROM cases WHERE client_token = ?').get(req.params.token);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  let data = {};
  try { data = JSON.parse(c.client_data || '{}'); } catch(e) {}
  res.json(data);
});

app.put('/api/client/:token/info', (req, res) => {
  const c = db.prepare('SELECT id FROM cases WHERE client_token = ?').get(req.params.token);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  const clientData = JSON.stringify(req.body.client_data || {});
  db.prepare("UPDATE cases SET client_data = ?, updated_at = datetime('now') WHERE id = ?").run(clientData, c.id);
  db.prepare('INSERT INTO activity_log (case_id, action, details, performed_by) VALUES (?, ?, ?, ?)')
    .run(c.id, 'client_info_updated', 'Client submitted personal information', 'Client');
  res.json({ success: true });
});

// ==================== GLOBAL SEARCH ====================

app.get('/api/search', requireAuth, (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) return res.json([]);
  const like = `%${q}%`;
  const role = req.session.user.role;
  let whereExtra = '';
  const params = [like, like, like, like];
  if (role === 'sales') { whereExtra = ' AND c.created_by = ?'; params.push(req.session.user.id); }
  else if (role === 'filing') { whereExtra = ' AND c.assigned_to = ?'; params.push(req.session.user.id); }
  const cases = db.prepare(`
    SELECT c.id, c.client_name, c.client_email, c.client_phone, c.application_number, c.stage, c.priority,
           ct.name as case_type_name, u1.full_name as assigned_to_name
    FROM cases c
    JOIN case_types ct ON c.case_type_id = ct.id
    LEFT JOIN users u1 ON c.assigned_to = u1.id
    WHERE c.deleted_at IS NULL AND (c.client_name LIKE ? OR c.client_email LIKE ? OR c.client_phone LIKE ? OR c.application_number LIKE ?)${whereExtra}
    ORDER BY c.created_at DESC LIMIT 10
  `).all(...params);
  res.json(cases);
});

// ==================== CASE NOTES ====================

app.get('/api/cases/:id/notes', requireAuth, (req, res) => {
  const notes = db.prepare(`
    SELECT n.*, u.full_name as user_name
    FROM case_notes n
    LEFT JOIN users u ON n.user_id = u.id
    WHERE n.case_id = ?
    ORDER BY n.created_at DESC
  `).all(parseInt(req.params.id));
  res.json(notes);
});

app.post('/api/cases/:id/notes', requireAuth, (req, res) => {
  const { note } = req.body;
  if (!note || !note.trim()) return res.status(400).json({ error: 'Note text required' });
  const caseId = parseInt(req.params.id);
  const result = db.prepare('INSERT INTO case_notes (case_id, user_id, note) VALUES (?, ?, ?)')
    .run(caseId, req.session.user.id, note.trim());
  db.prepare('INSERT INTO activity_log (case_id, action, details, performed_by) VALUES (?, ?, ?, ?)')
    .run(caseId, 'note_added', 'Internal note added', req.session.user.full_name);
  res.json({ id: result.lastInsertRowid });
});

app.delete('/api/notes/:id', requireAuth, (req, res) => {
  const note = db.prepare('SELECT * FROM case_notes WHERE id = ?').get(parseInt(req.params.id));
  if (!note) return res.status(404).json({ error: 'Note not found' });
  if (note.user_id !== req.session.user.id && !isAdmin(req.session.user.role)) return res.status(403).json({ error: 'Can only delete your own notes' });
  db.prepare('DELETE FROM case_notes WHERE id = ?').run(parseInt(req.params.id));
  res.json({ success: true });
});

// ==================== CASE TASKS ====================

app.get('/api/cases/:id/tasks', requireAuth, (req, res) => {
  const tasks = db.prepare(`
    SELECT t.*, u1.full_name as assigned_to_name, u2.full_name as created_by_name
    FROM case_tasks t
    LEFT JOIN users u1 ON t.assigned_to = u1.id
    LEFT JOIN users u2 ON t.created_by = u2.id
    WHERE t.case_id = ?
    ORDER BY t.is_completed ASC, t.due_date ASC
  `).all(parseInt(req.params.id));
  res.json(tasks);
});

app.post('/api/cases/:id/tasks', requireAuth, (req, res) => {
  const { title, due_date, assigned_to } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'Task title required' });
  const caseId = parseInt(req.params.id);
  const result = db.prepare('INSERT INTO case_tasks (case_id, title, due_date, assigned_to, created_by) VALUES (?, ?, ?, ?, ?)')
    .run(caseId, title.trim(), due_date || null, assigned_to ? parseInt(assigned_to) : req.session.user.id, req.session.user.id);
  db.prepare('INSERT INTO activity_log (case_id, action, details, performed_by) VALUES (?, ?, ?, ?)')
    .run(caseId, 'task_added', 'Task: ' + title.trim(), req.session.user.full_name);
  res.json({ id: result.lastInsertRowid });
});

app.put('/api/tasks/:id', requireAuth, (req, res) => {
  const { is_completed, title, due_date } = req.body;
  const taskId = parseInt(req.params.id);
  const fields = [];
  const params = [];
  if (is_completed !== undefined) {
    fields.push('is_completed = ?'); params.push(is_completed ? 1 : 0);
    if (is_completed) { fields.push("completed_at = datetime('now')"); }
    else { fields.push('completed_at = NULL'); }
  }
  if (title !== undefined) { fields.push('title = ?'); params.push(title); }
  if (due_date !== undefined) { fields.push('due_date = ?'); params.push(due_date); }
  if (fields.length === 0) return res.status(400).json({ error: 'Nothing to update' });
  params.push(taskId);
  db.prepare(`UPDATE case_tasks SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json({ success: true });
});

app.delete('/api/tasks/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM case_tasks WHERE id = ?').run(parseInt(req.params.id));
  res.json({ success: true });
});

// My pending tasks across all cases
app.get('/api/tasks/my', requireAuth, (req, res) => {
  const tasks = db.prepare(`
    SELECT t.*, c.client_name, ct.name as case_type_name
    FROM case_tasks t
    JOIN cases c ON t.case_id = c.id
    JOIN case_types ct ON c.case_type_id = ct.id
    WHERE t.assigned_to = ? AND t.is_completed = 0 AND c.deleted_at IS NULL
    ORDER BY t.due_date ASC NULLS LAST
  `).all(req.session.user.id);
  res.json(tasks);
});

// Overdue tasks
app.get('/api/tasks/overdue', requireAuth, (req, res) => {
  const tasks = db.prepare(`
    SELECT t.*, c.client_name, u1.full_name as assigned_to_name
    FROM case_tasks t
    JOIN cases c ON t.case_id = c.id
    LEFT JOIN users u1 ON t.assigned_to = u1.id
    WHERE t.is_completed = 0 AND t.due_date < date('now') AND c.deleted_at IS NULL
    ORDER BY t.due_date ASC
  `).all();
  res.json(tasks);
});

// ==================== CASE MANAGEMENT ====================

app.put('/api/cases/:id/assign', requireAuth, (req, res) => {
  if (!canAssign(req.session.user.role)) return res.status(403).json({ error: 'Only admin or team lead can assign' });
  const { assigned_to } = req.body;
  const caseId = parseInt(req.params.id);
  const c = db.prepare('SELECT client_name, stage FROM cases WHERE id = ?').get(caseId);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  const newStage = (c.stage === 'new') ? 'assigned' : c.stage;
  db.prepare("UPDATE cases SET assigned_to = ?, stage = ?, updated_at = datetime('now') WHERE id = ?").run(parseInt(assigned_to), newStage, caseId);
  db.prepare('INSERT INTO notifications (user_id, case_id, type, message) VALUES (?, ?, ?, ?)').run(parseInt(assigned_to), caseId, 'assignment', `New case assigned: ${c.client_name}`);
  db.prepare('INSERT INTO activity_log (case_id, action, details, performed_by) VALUES (?, ?, ?, ?)').run(caseId, 'case_assigned', 'Case assigned', req.session.user.full_name);
  res.json({ success: true });
});

app.put('/api/cases/:id/stage', requireAuth, (req, res) => {
  const caseId = parseInt(req.params.id);
  db.prepare("UPDATE cases SET stage = ?, updated_at = datetime('now') WHERE id = ?").run(req.body.stage, caseId);
  db.prepare('INSERT INTO activity_log (case_id, action, details, performed_by) VALUES (?, ?, ?, ?)').run(caseId, 'stage_changed', `Stage: ${req.body.stage}`, req.session.user.full_name);
  res.json({ success: true });
});

app.put('/api/cases/:id/priority', requireAuth, (req, res) => {
  const caseId = parseInt(req.params.id);
  db.prepare("UPDATE cases SET priority = ?, urgency_reason = ?, updated_at = datetime('now') WHERE id = ?").run(req.body.priority, req.body.urgency_reason || '', caseId);
  db.prepare('INSERT INTO activity_log (case_id, action, details, performed_by) VALUES (?, ?, ?, ?)').run(caseId, 'priority_changed', `Priority: ${req.body.priority}`, req.session.user.full_name);
  res.json({ success: true });
});

// ==================== DASHBOARD STATS ====================

app.get('/api/stats', requireAuth, (req, res) => {
  const role = req.session.user.role;

  const D = 'AND deleted_at IS NULL';
  const totalCases = db.prepare(`SELECT COUNT(*) as count FROM cases WHERE deleted_at IS NULL`).get().count;
  const newCases = db.prepare(`SELECT COUNT(*) as count FROM cases WHERE stage = 'new' ${D}`).get().count;
  const assignedCases = db.prepare(`SELECT COUNT(*) as count FROM cases WHERE stage = 'assigned' ${D}`).get().count;
  const inProgressCases = db.prepare(`SELECT COUNT(*) as count FROM cases WHERE stage = 'in_progress' ${D}`).get().count;
  const submittedCases = db.prepare(`SELECT COUNT(*) as count FROM cases WHERE stage = 'submitted' ${D}`).get().count;
  const highPriority = db.prepare(`SELECT COUNT(*) as count FROM cases WHERE priority = 'high' AND stage NOT IN ('submitted','approved','refused','withdrawn') ${D}`).get().count;
  const overdueCases = db.prepare(`SELECT COUNT(*) as count FROM cases WHERE sla_deadline < date('now') AND stage NOT IN ('submitted','approved','refused','withdrawn') ${D}`).get().count;

  const totalDocs = db.prepare('SELECT COUNT(*) as count FROM case_documents cd JOIN cases c ON cd.case_id = c.id WHERE c.deleted_at IS NULL').get().count;
  const uploadedDocs = db.prepare("SELECT COUNT(*) as count FROM case_documents cd JOIN cases c ON cd.case_id = c.id WHERE cd.status = 'uploaded' AND c.deleted_at IS NULL").get().count;

  const recentActivity = db.prepare('SELECT al.*, c.client_name FROM activity_log al LEFT JOIN cases c ON al.case_id = c.id WHERE c.deleted_at IS NULL OR c.id IS NULL ORDER BY al.created_at DESC').all().slice(0, 20);

  const result = {
    cases: { total: totalCases },
    stages: { new: newCases, assigned: assignedCases, in_progress: inProgressCases, submitted: submittedCases },
    priority: { high: highPriority },
    overdue: overdueCases,
    documents: { total: totalDocs, uploaded: uploadedDocs },
    recentActivity
  };

  // Finance only for admin
  if (isAdmin(role)) {
    const totalFees = db.prepare('SELECT COALESCE(SUM(cf.amount), 0) as total FROM case_fees cf JOIN cases c ON cf.case_id = c.id WHERE c.deleted_at IS NULL').get().total;
    const totalPaid = db.prepare('SELECT COALESCE(SUM(cp.amount), 0) as total FROM case_payments cp JOIN cases c ON cp.case_id = c.id WHERE c.deleted_at IS NULL').get().total;
    result.finance = { total_fees: totalFees, total_paid: totalPaid, total_due: totalFees - totalPaid };
  }

  res.json(result);
});

// Staff workload (admin + team_lead)
app.get('/api/workload', requireAuth, (req, res) => {
  const workload = db.prepare(`
    SELECT u.id, u.full_name, u.role,
           COUNT(c.id) as total_cases,
           SUM(CASE WHEN c.stage IN ('assigned','in_progress','docs_complete','filing') THEN 1 ELSE 0 END) as active_cases,
           SUM(CASE WHEN c.priority = 'high' THEN 1 ELSE 0 END) as high_priority,
           SUM(CASE WHEN c.sla_deadline < date('now') AND c.stage NOT IN ('submitted','approved','refused','withdrawn') THEN 1 ELSE 0 END) as overdue
    FROM users u
    LEFT JOIN cases c ON c.assigned_to = u.id AND c.stage NOT IN ('approved','refused','withdrawn') AND c.deleted_at IS NULL
    WHERE u.role IN ('filing', 'team_lead', 'admin')
    GROUP BY u.id ORDER BY active_cases DESC
  `).all();
  res.json(workload);
});

// ==================== STATISTICS (admin only) ====================

// Counsellor-wise stats
app.get('/api/stats/counsellors', requireRole('admin'), (req, res) => {
  const stats = db.prepare(`
    SELECT u.id, u.full_name,
           COUNT(c.id) as total_cases,
           SUM(CASE WHEN c.stage IN ('new','assigned','in_progress','docs_complete','filing') THEN 1 ELSE 0 END) as active_cases,
           SUM(CASE WHEN c.stage IN ('submitted','in_process') THEN 1 ELSE 0 END) as submitted_cases,
           SUM(CASE WHEN c.stage = 'approved' THEN 1 ELSE 0 END) as approved_cases,
           SUM(CASE WHEN c.stage = 'refused' THEN 1 ELSE 0 END) as refused_cases,
           COALESCE(f.total_fees, 0) as total_sales,
           COALESCE(p.total_paid, 0) as total_collected,
           COALESCE(f.total_fees, 0) - COALESCE(p.total_paid, 0) as total_pending
    FROM users u
    LEFT JOIN cases c ON c.created_by = u.id AND c.deleted_at IS NULL
    LEFT JOIN (SELECT c2.created_by, SUM(cf.amount) as total_fees FROM case_fees cf JOIN cases c2 ON cf.case_id = c2.id WHERE c2.deleted_at IS NULL GROUP BY c2.created_by) f ON f.created_by = u.id
    LEFT JOIN (SELECT c3.created_by, SUM(cp.amount) as total_paid FROM case_payments cp JOIN cases c3 ON cp.case_id = c3.id WHERE c3.deleted_at IS NULL GROUP BY c3.created_by) p ON p.created_by = u.id
    WHERE u.role IN ('sales', 'admin', 'team_lead')
    GROUP BY u.id ORDER BY total_cases DESC
  `).all();
  res.json(stats);
});

// Counsellor's cases detail
app.get('/api/stats/counsellors/:id/cases', requireRole('admin'), (req, res) => {
  const cases = db.prepare(`
    SELECT c.id, c.client_name, ct.name as case_type_name, c.stage, c.priority, c.created_at,
           u1.full_name as assigned_to_name,
           COALESCE(f.total_fees, 0) as total_fees,
           COALESCE(p.total_paid, 0) as total_paid
    FROM cases c
    JOIN case_types ct ON c.case_type_id = ct.id
    LEFT JOIN users u1 ON c.assigned_to = u1.id
    LEFT JOIN (SELECT case_id, SUM(amount) as total_fees FROM case_fees GROUP BY case_id) f ON f.case_id = c.id
    LEFT JOIN (SELECT case_id, SUM(amount) as total_paid FROM case_payments GROUP BY case_id) p ON p.case_id = c.id
    WHERE c.created_by = ? AND c.deleted_at IS NULL
    ORDER BY c.created_at DESC
  `).all(parseInt(req.params.id));
  res.json(cases);
});

// Staff-wise stats
app.get('/api/stats/staff', requireAuth, (req, res) => {
  if (!canAssign(req.session.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const stats = db.prepare(`
    SELECT u.id, u.full_name, u.role,
           COUNT(c.id) as total_assigned,
           SUM(CASE WHEN c.stage = 'assigned' THEN 1 ELSE 0 END) as assigned,
           SUM(CASE WHEN c.stage = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
           SUM(CASE WHEN c.stage IN ('docs_complete','filing') THEN 1 ELSE 0 END) as docs_complete,
           SUM(CASE WHEN c.stage = 'submitted' THEN 1 ELSE 0 END) as submitted,
           SUM(CASE WHEN c.stage = 'approved' THEN 1 ELSE 0 END) as approved,
           SUM(CASE WHEN c.stage = 'refused' THEN 1 ELSE 0 END) as refused,
           SUM(CASE WHEN c.sla_deadline < date('now') AND c.stage NOT IN ('submitted','approved','refused','withdrawn') THEN 1 ELSE 0 END) as overdue
    FROM users u
    LEFT JOIN cases c ON c.assigned_to = u.id AND c.deleted_at IS NULL
    WHERE u.role IN ('filing', 'team_lead')
    GROUP BY u.id ORDER BY total_assigned DESC
  `).all();
  res.json(stats);
});

// SLA config
app.get('/api/sla-config', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT sc.*, ct.name as case_type_name FROM sla_config sc JOIN case_types ct ON sc.case_type_id = ct.id ORDER BY ct.name').all());
});

app.put('/api/sla-config/:id', requireRole('admin'), (req, res) => {
  const { expected_days, warning_days, points } = req.body;
  db.prepare('UPDATE sla_config SET expected_days = ?, warning_days = ?, points = ? WHERE id = ?')
    .run(parseInt(expected_days), parseInt(warning_days), parseInt(points || 5), parseInt(req.params.id));
  res.json({ success: true });
});

// ==================== FINANCE (admin only for dashboard) ====================

app.get('/api/cases/:id/fees', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM case_fees WHERE case_id = ? ORDER BY created_at').all(parseInt(req.params.id)));
});

app.post('/api/cases/:id/fees', requireAuth, (req, res) => {
  const { fee_type, amount, description } = req.body;
  const caseId = parseInt(req.params.id);
  if (!fee_type || !amount) return res.status(400).json({ error: 'Fee type and amount required' });
  const result = db.prepare('INSERT INTO case_fees (case_id, fee_type, amount, description) VALUES (?, ?, ?, ?)').run(caseId, fee_type, parseFloat(amount), description || '');
  db.prepare('INSERT INTO activity_log (case_id, action, details, performed_by) VALUES (?, ?, ?, ?)').run(caseId, 'fee_added', `Fee: $${parseFloat(amount).toFixed(2)} (${fee_type})`, req.session.user.full_name);
  res.json({ id: result.lastInsertRowid });
});

app.delete('/api/fees/:id', requireRole('admin', 'team_lead'), (req, res) => {
  const fee = db.prepare('SELECT * FROM case_fees WHERE id = ?').get(parseInt(req.params.id));
  if (!fee) return res.status(404).json({ error: 'Fee not found' });
  db.prepare('DELETE FROM case_fees WHERE id = ?').run(parseInt(req.params.id));
  db.prepare('INSERT INTO activity_log (case_id, action, details, performed_by) VALUES (?, ?, ?, ?)').run(fee.case_id, 'fee_removed', `Fee removed: $${fee.amount.toFixed(2)}`, req.session.user.full_name);
  res.json({ success: true });
});

app.get('/api/cases/:id/payments', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT p.*, u.full_name as recorded_by_name FROM case_payments p LEFT JOIN users u ON p.recorded_by = u.id WHERE p.case_id = ? ORDER BY p.payment_date').all(parseInt(req.params.id)));
});

app.post('/api/cases/:id/payments', requireAuth, (req, res) => {
  const { amount, payment_date, payment_method, installment_number, notes } = req.body;
  const caseId = parseInt(req.params.id);
  if (!amount || !payment_date) return res.status(400).json({ error: 'Amount and date required' });
  const result = db.prepare('INSERT INTO case_payments (case_id, amount, payment_date, payment_method, installment_number, notes, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(caseId, parseFloat(amount), payment_date, payment_method || '', installment_number || null, notes || '', req.session.user.id);
  db.prepare('INSERT INTO activity_log (case_id, action, details, performed_by) VALUES (?, ?, ?, ?)').run(caseId, 'payment_recorded', `Payment: $${parseFloat(amount).toFixed(2)}`, req.session.user.full_name);
  res.json({ id: result.lastInsertRowid });
});

app.delete('/api/payments/:id', requireRole('admin', 'team_lead'), (req, res) => {
  const payment = db.prepare('SELECT * FROM case_payments WHERE id = ?').get(parseInt(req.params.id));
  if (!payment) return res.status(404).json({ error: 'Payment not found' });
  db.prepare('DELETE FROM case_payments WHERE id = ?').run(parseInt(req.params.id));
  db.prepare('INSERT INTO activity_log (case_id, action, details, performed_by) VALUES (?, ?, ?, ?)').run(payment.case_id, 'payment_removed', `Payment removed: $${payment.amount.toFixed(2)}`, req.session.user.full_name);
  res.json({ success: true });
});

app.get('/api/cases/:id/balance', requireAuth, (req, res) => {
  const caseId = parseInt(req.params.id);
  const fees = db.prepare('SELECT * FROM case_fees WHERE case_id = ?').all(caseId);
  const payments = db.prepare('SELECT * FROM case_payments WHERE case_id = ? ORDER BY payment_date').all(caseId);
  const totalFees = fees.reduce((sum, f) => sum + f.amount, 0);
  const filingFees = fees.filter(f => f.fee_type === 'processing').reduce((sum, f) => sum + f.amount, 0);
  const govtFees = fees.filter(f => f.fee_type !== 'processing').reduce((sum, f) => sum + f.amount, 0);
  const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);
  // Balance due = filing fees - payments (govt fees tracked separately)
  const filingBalance = Math.max(0, filingFees - totalPaid);
  res.json({ fees, payments, total_fees: totalFees, filing_fees: filingFees, govt_fees: govtFees,
    total_paid: totalPaid, balance_due: filingBalance, total_owed: totalFees - totalPaid });
});

app.get('/api/finance/summary', requireRole('admin'), (req, res) => {
  const totalFees = db.prepare('SELECT COALESCE(SUM(cf.amount), 0) as total FROM case_fees cf JOIN cases cx ON cf.case_id = cx.id WHERE cx.deleted_at IS NULL').get().total;
  const totalPaid = db.prepare('SELECT COALESCE(SUM(cp.amount), 0) as total FROM case_payments cp JOIN cases cx ON cp.case_id = cx.id WHERE cx.deleted_at IS NULL').get().total;
  const revenueFees = db.prepare("SELECT COALESCE(SUM(cf.amount), 0) as total FROM case_fees cf JOIN cases cx ON cf.case_id = cx.id WHERE cf.fee_type = 'processing' AND cx.deleted_at IS NULL").get().total;
  const govtFees = db.prepare("SELECT COALESCE(SUM(cf.amount), 0) as total FROM case_fees cf JOIN cases cx ON cf.case_id = cx.id WHERE cf.fee_type IN ('application', 'government') AND cx.deleted_at IS NULL").get().total;
  const byFeeType = db.prepare('SELECT cf.fee_type, SUM(cf.amount) as total FROM case_fees cf JOIN cases cx ON cf.case_id = cx.id WHERE cx.deleted_at IS NULL GROUP BY cf.fee_type').all();
  const byMethod = db.prepare("SELECT COALESCE(cp.payment_method, 'unspecified') as method, SUM(cp.amount) as total FROM case_payments cp JOIN cases cx ON cp.case_id = cx.id WHERE cx.deleted_at IS NULL GROUP BY cp.payment_method").all();
  const monthlyRevenue = db.prepare("SELECT strftime('%Y-%m', cp.payment_date) as month, SUM(cp.amount) as total FROM case_payments cp JOIN cases cx ON cp.case_id = cx.id WHERE cx.deleted_at IS NULL AND cp.payment_date >= date('now', '-12 months') GROUP BY month ORDER BY month").all();
  const aging = db.prepare(`
    SELECT c.id, c.client_name, ct.name as case_type_name, c.stage, c.created_at,
           u1.full_name as assigned_to_name, u2.full_name as created_by_name,
           COALESCE(f.total_fees, 0) as total_fees, COALESCE(p.total_paid, 0) as total_paid,
           COALESCE(f.total_fees, 0) - COALESCE(p.total_paid, 0) as balance_due
    FROM cases c JOIN case_types ct ON c.case_type_id = ct.id
    LEFT JOIN users u1 ON c.assigned_to = u1.id
    LEFT JOIN users u2 ON c.created_by = u2.id
    LEFT JOIN (SELECT case_id, SUM(amount) as total_fees FROM case_fees GROUP BY case_id) f ON f.case_id = c.id
    LEFT JOIN (SELECT case_id, SUM(amount) as total_paid FROM case_payments GROUP BY case_id) p ON p.case_id = c.id
    WHERE c.deleted_at IS NULL AND COALESCE(f.total_fees, 0) - COALESCE(p.total_paid, 0) > 0 ORDER BY balance_due DESC
  `).all();
  res.json({ total_fees: totalFees, total_paid: totalPaid, total_due: totalFees - totalPaid, revenue_fees: revenueFees, govt_fees: govtFees, by_fee_type: byFeeType, by_method: byMethod, monthly_revenue: monthlyRevenue, aging });
});

// Outstanding payments — admin + team_lead
app.get('/api/finance/outstanding', requireAuth, (req, res) => {
  if (!canAssign(req.session.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const aging = db.prepare(`
    SELECT c.id, c.client_name, ct.name as case_type_name, c.stage, c.created_at, u1.full_name as assigned_to_name,
           COALESCE(f.total_fees, 0) as total_fees, COALESCE(p.total_paid, 0) as total_paid,
           COALESCE(f.total_fees, 0) - COALESCE(p.total_paid, 0) as balance_due
    FROM cases c JOIN case_types ct ON c.case_type_id = ct.id
    LEFT JOIN users u1 ON c.assigned_to = u1.id
    LEFT JOIN (SELECT case_id, SUM(amount) as total_fees FROM case_fees GROUP BY case_id) f ON f.case_id = c.id
    LEFT JOIN (SELECT case_id, SUM(amount) as total_paid FROM case_payments GROUP BY case_id) p ON p.case_id = c.id
    WHERE c.deleted_at IS NULL AND COALESCE(f.total_fees, 0) - COALESCE(p.total_paid, 0) > 0 ORDER BY balance_due DESC
  `).all();
  const totalDue = aging.reduce((s, a) => s + a.balance_due, 0);
  res.json({ aging, total_due: totalDue });
});

// ==================== LEADERBOARD ====================

app.get('/api/leaderboard', requireAuth, (req, res) => {
  const period = req.query.period || 'current_month';
  let dateFilter = '';
  const now = new Date();
  if (period === 'current_month') {
    dateFilter = `AND c.created_at >= '${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01'`;
  } else if (period === '1m') {
    const d = new Date(); d.setMonth(d.getMonth()-1);
    dateFilter = `AND c.created_at >= '${d.toISOString().split('T')[0]}'`;
  } else if (period === '3m') {
    const d = new Date(); d.setMonth(d.getMonth()-3);
    dateFilter = `AND c.created_at >= '${d.toISOString().split('T')[0]}'`;
  } else if (period === '6m') {
    const d = new Date(); d.setMonth(d.getMonth()-6);
    dateFilter = `AND c.created_at >= '${d.toISOString().split('T')[0]}'`;
  }
  // else 'all' — no date filter

  // Sales leaderboard: points from cases created
  const sales = db.prepare(`
    SELECT u.id, u.full_name, u.role,
           COUNT(c.id) as cases_created,
           COALESCE(SUM(sc.points), 0) as total_points,
           COALESCE(f.total_fees, 0) as revenue
    FROM users u
    LEFT JOIN cases c ON c.created_by = u.id AND c.deleted_at IS NULL ${dateFilter}
    LEFT JOIN sla_config sc ON sc.case_type_id = c.case_type_id
    LEFT JOIN (
      SELECT c2.created_by, SUM(cf.amount) as total_fees
      FROM case_fees cf JOIN cases c2 ON cf.case_id = c2.id
      WHERE c2.deleted_at IS NULL AND cf.fee_type = 'processing' ${dateFilter.replace(/c\./g, 'c2.')}
      GROUP BY c2.created_by
    ) f ON f.created_by = u.id
    WHERE u.role IN ('sales', 'admin', 'team_lead') AND u.is_active = 1
    GROUP BY u.id
    HAVING cases_created > 0
    ORDER BY total_points DESC, revenue DESC
  `).all();

  // Filing leaderboard: cases moved to submitted/approved
  const filing = db.prepare(`
    SELECT u.id, u.full_name, u.role,
           COUNT(c.id) as cases_completed,
           COALESCE(SUM(sc.points), 0) as total_points
    FROM users u
    LEFT JOIN cases c ON c.assigned_to = u.id AND c.deleted_at IS NULL
      AND c.stage IN ('submitted','in_process','approved') ${dateFilter}
    LEFT JOIN sla_config sc ON sc.case_type_id = c.case_type_id
    WHERE u.role IN ('filing', 'team_lead') AND u.is_active = 1
    GROUP BY u.id
    HAVING cases_completed > 0
    ORDER BY total_points DESC, cases_completed DESC
  `).all();

  res.json({ sales, filing });
});

// ==================== FEE EDIT ====================

app.put('/api/fees/:id', requireAuth, (req, res) => {
  const fee = db.prepare('SELECT cf.*, c.created_by FROM case_fees cf JOIN cases c ON cf.case_id = c.id WHERE cf.id = ?').get(parseInt(req.params.id));
  if (!fee) return res.status(404).json({ error: 'Fee not found' });
  // Allow edit by: case creator, admin, or team_lead
  if (fee.created_by !== req.session.user.id && !isAdmin(req.session.user.role) && req.session.user.role !== 'team_lead') {
    return res.status(403).json({ error: 'Only case creator or admin can edit fees' });
  }
  const { amount, fee_type, description, govt_fee_status } = req.body;
  const fields = []; const params = [];
  if (amount !== undefined) { fields.push('amount = ?'); params.push(parseFloat(amount)); }
  if (fee_type !== undefined) { fields.push('fee_type = ?'); params.push(fee_type); }
  if (description !== undefined) { fields.push('description = ?'); params.push(description); }
  if (govt_fee_status !== undefined) { fields.push('govt_fee_status = ?'); params.push(govt_fee_status); }
  if (fields.length === 0) return res.status(400).json({ error: 'Nothing to update' });
  params.push(parseInt(req.params.id));
  db.prepare(`UPDATE case_fees SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  db.prepare('INSERT INTO activity_log (case_id, action, details, performed_by) VALUES (?, ?, ?, ?)')
    .run(fee.case_id, 'fee_updated', `Fee updated: ${fee_type || fee.fee_type}`, req.session.user.full_name);
  res.json({ success: true });
});

// ==================== CASE DELETE (soft-delete) ====================

app.put('/api/cases/:id/delete', requireRole('admin'), (req, res) => {
  const caseId = parseInt(req.params.id);
  db.prepare("UPDATE cases SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(caseId);
  db.prepare('INSERT INTO activity_log (case_id, action, details, performed_by) VALUES (?, ?, ?, ?)')
    .run(caseId, 'case_deleted', 'Case soft-deleted', req.session.user.full_name);
  res.json({ success: true });
});

app.put('/api/cases/:id/restore', requireRole('admin'), (req, res) => {
  const caseId = parseInt(req.params.id);
  db.prepare("UPDATE cases SET deleted_at = NULL, updated_at = datetime('now') WHERE id = ?").run(caseId);
  db.prepare('INSERT INTO activity_log (case_id, action, details, performed_by) VALUES (?, ?, ?, ?)')
    .run(caseId, 'case_restored', 'Case restored', req.session.user.full_name);
  res.json({ success: true });
});

// Staff drill-down cases
app.get('/api/stats/staff/:id/cases', requireAuth, (req, res) => {
  if (!canAssign(req.session.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const cases = db.prepare(`
    SELECT c.id, c.client_name, ct.name as case_type_name, c.stage, c.priority, c.sla_deadline, c.created_at,
           u2.full_name as created_by_name
    FROM cases c
    JOIN case_types ct ON c.case_type_id = ct.id
    LEFT JOIN users u2 ON c.created_by = u2.id
    WHERE c.assigned_to = ? AND c.deleted_at IS NULL
    ORDER BY c.created_at DESC
  `).all(parseInt(req.params.id));
  res.json(cases);
});

// ==================== CSV EXPORT (admin only) ====================

app.get('/api/export/cases', requireRole('admin'), (req, res) => {
  const cases = db.prepare(`
    SELECT c.id, c.client_name, c.client_email, c.client_phone, ct.name as case_type,
           c.stage, c.priority, c.sla_deadline, c.application_number,
           u1.full_name as assigned_to, u2.full_name as created_by,
           c.notes, c.service_details, c.created_at, c.updated_at
    FROM cases c
    JOIN case_types ct ON c.case_type_id = ct.id
    LEFT JOIN users u1 ON c.assigned_to = u1.id
    LEFT JOIN users u2 ON c.created_by = u2.id
    WHERE c.deleted_at IS NULL
    ORDER BY c.created_at DESC
  `).all();

  const headers = ['ID','Client Name','Email','Phone','Case Type','Stage','Priority','SLA Deadline','Application #','Assigned To','Created By','Notes','Service Details','Created','Updated'];
  const rows = cases.map(c => [c.id, c.client_name, c.client_email, c.client_phone, c.case_type, c.stage, c.priority, c.sla_deadline, c.application_number, c.assigned_to, c.created_by, c.notes, c.service_details, c.created_at, c.updated_at].map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(','));

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=cases_export.csv');
  res.send([headers.join(','), ...rows].join('\n'));
});

app.get('/api/export/finance', requireRole('admin'), (req, res) => {
  const data = db.prepare(`
    SELECT c.id as case_id, c.client_name, ct.name as case_type,
           COALESCE(f.total_fees, 0) as total_fees,
           COALESCE(p.total_paid, 0) as total_paid,
           COALESCE(f.total_fees, 0) - COALESCE(p.total_paid, 0) as balance_due,
           u2.full_name as created_by
    FROM cases c
    JOIN case_types ct ON c.case_type_id = ct.id
    LEFT JOIN users u2 ON c.created_by = u2.id
    LEFT JOIN (SELECT case_id, SUM(amount) as total_fees FROM case_fees GROUP BY case_id) f ON f.case_id = c.id
    LEFT JOIN (SELECT case_id, SUM(amount) as total_paid FROM case_payments GROUP BY case_id) p ON p.case_id = c.id
    WHERE c.deleted_at IS NULL
    ORDER BY c.created_at DESC
  `).all();

  const headers = ['Case ID','Client Name','Case Type','Total Fees','Total Paid','Balance Due','Created By'];
  const rows = data.map(r => [r.case_id, r.client_name, r.case_type, r.total_fees.toFixed(2), r.total_paid.toFixed(2), r.balance_due.toFixed(2), r.created_by].map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(','));

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=finance_export.csv');
  res.send([headers.join(','), ...rows].join('\n'));
});

app.get('/api/export/clients', requireRole('admin'), (req, res) => {
  const cases = db.prepare(`
    SELECT c.id, c.client_name, c.client_email, c.client_phone, c.client_data, ct.name as case_type
    FROM cases c JOIN case_types ct ON c.case_type_id = ct.id
    WHERE c.deleted_at IS NULL ORDER BY c.client_name
  `).all();

  const headers = ['Client Name','Email','Phone','Case Type','DOB','Citizenship','Immigration Status','Passport #','Education','Language Test','Work Experience'];
  const rows = cases.map(c => {
    let cd = {};
    try { cd = JSON.parse(c.client_data || '{}'); } catch(e) {}
    return [c.client_name, c.client_email, c.client_phone, c.case_type, cd.dob, cd.citizenship, cd.immigration_status, cd.passport_number, cd.education_level, cd.language_test, cd.work_experience].map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(',');
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=clients_export.csv');
  res.send([headers.join(','), ...rows].join('\n'));
});

// ==================== NOTIFICATIONS ====================

app.get('/api/notifications', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT n.*, c.client_name FROM notifications n LEFT JOIN cases c ON n.case_id = c.id WHERE n.user_id = ? ORDER BY n.created_at DESC').all(req.session.user.id).slice(0, 50));
});

app.get('/api/notifications/count', requireAuth, (req, res) => {
  res.json({ count: db.prepare('SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0').get(req.session.user.id).count });
});

app.put('/api/notifications/:id/read', requireAuth, (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(parseInt(req.params.id), req.session.user.id);
  res.json({ success: true });
});

app.put('/api/notifications/read-all', requireAuth, (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.session.user.id);
  res.json({ success: true });
});

// ==================== BACKUP SYSTEM ====================

// Store backups INSIDE the persistent db/ volume so they survive deploys
const BACKUP_DIR = path.join(__dirname, 'db', 'backups');

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function createBackup(label) {
  ensureBackupDir();
  if (!fs.existsSync(DB_PATH)) return null;

  // Checkpoint WAL to ensure all data is in the main DB file
  try { if (db) db.pragma('wal_checkpoint(TRUNCATE)'); } catch(e) {}

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const filename = `backup_${label || 'auto'}_${timestamp}.db`;
  const backupPath = path.join(BACKUP_DIR, filename);
  fs.copyFileSync(DB_PATH, backupPath);
  console.log(`Backup created: ${filename}`);

  // All backups are kept forever — no deletion
  return filename;
}

// Admin: download live database backup
app.get('/api/backup/download', requireRole('admin'), (req, res) => {
  try {
    if (db) db.pragma('wal_checkpoint(TRUNCATE)');
  } catch(e) {}
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  res.setHeader('Content-Disposition', `attachment; filename="rp-cms-backup-${timestamp}.db"`);
  res.setHeader('Content-Type', 'application/x-sqlite3');
  const stream = fs.createReadStream(DB_PATH);
  stream.pipe(res);
});

// Admin: trigger manual backup (saved on server)
app.post('/api/backup/create', requireRole('admin'), (req, res) => {
  const filename = createBackup('manual');
  if (filename) {
    res.json({ success: true, filename, message: 'Backup created on server' });
  } else {
    res.status(500).json({ error: 'Backup failed — database file not found' });
  }
});

// Admin: list available backups on server
app.get('/api/backup/list', requireRole('admin'), (req, res) => {
  ensureBackupDir();
  const backups = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('backup_') && f.endsWith('.db'))
    .map(f => {
      const stat = fs.statSync(path.join(BACKUP_DIR, f));
      return { filename: f, size: stat.size, created: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.created.localeCompare(a.created));
  res.json(backups);
});

// Admin: download a specific server-side backup
app.get('/api/backup/download/:filename', requireRole('admin'), (req, res) => {
  const filename = req.params.filename.replace(/[^a-zA-Z0-9_\-\.]/g, '');
  const filePath = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(filePath) || !filename.startsWith('backup_')) {
    return res.status(404).json({ error: 'Backup not found' });
  }
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/x-sqlite3');
  fs.createReadStream(filePath).pipe(res);
});

// ==================== SERVE PAGES ====================

app.get('/', (req, res) => res.redirect('/staff'));
app.get('/staff', (req, res) => res.sendFile(path.join(__dirname, 'public', 'staff', 'login.html')));
app.get('/staff/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'staff', 'dashboard.html')));
app.get('/portal/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'client', 'portal.html')));

// ==================== START ====================

async function start() {
  db = await initDatabase();

  // Safety backup on every startup (before app serves any requests)
  try {
    createBackup('startup');
    console.log('  Startup safety backup created.');
  } catch(e) { console.error('Startup backup failed:', e.message); }

  // Scheduled auto-backup every 6 hours
  setInterval(() => {
    try { createBackup('auto'); } catch(e) { console.error('Auto backup failed:', e.message); }
  }, 6 * 60 * 60 * 1000);

  app.listen(PORT, () => {
    console.log(`\n  RP Immigration Consulting - Filing Operations Toolkit`);
    console.log(`  Server running at http://localhost:${PORT}`);
    console.log(`  Auto-backup: every 6 hours, all backups kept forever on persistent volume`);
    console.log(`\n  Staff login:     http://localhost:${PORT}/staff`);
    console.log(`  Default login:   admin / admin123\n`);
  });
}

start().catch(err => { console.error('Failed to start:', err); process.exit(1); });
