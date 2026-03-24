const express = require('express');
const session = require('express-session');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { initDatabase } = require('./database');

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

// Session secret: use env var, or generate and persist to .session-secret file
function getSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const secretFile = path.join(__dirname, '.session-secret');
  if (fs.existsSync(secretFile)) return fs.readFileSync(secretFile, 'utf8').trim();
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretFile, secret, { mode: 0o600 });
  return secret;
}

// Middleware - security headers first (before static files)
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

app.use(session({
  secret: getSessionSecret(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'lax'
  }
}));

let db = null;

function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

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

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
  if (req.session && req.session.user) {
    res.json({ user: req.session.user });
  } else {
    res.status(401).json({ error: 'Not logged in' });
  }
});

// ==================== USER MANAGEMENT ====================

app.get('/api/users', requireAuth, (req, res) => {
  const users = db.prepare('SELECT id, username, full_name, role, created_at FROM users').all();
  res.json(users);
});

app.post('/api/users', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { username, password, full_name, role } = req.body;
  try {
    const hash = bcrypt.hashSync(password, 10);
    const result = db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?, ?, ?, ?)')
      .run(username, hash, full_name, role || 'filing');
    res.json({ id: result.lastInsertRowid, username, full_name, role: role || 'filing' });
  } catch (err) {
    res.status(400).json({ error: 'Username already exists' });
  }
});

app.delete('/api/users/:id', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  db.prepare('DELETE FROM users WHERE id = ? AND role != ?').run(parseInt(req.params.id), 'admin');
  res.json({ success: true });
});

// ==================== CASE TYPES ====================

app.get('/api/case-types', requireAuth, (req, res) => {
  const types = db.prepare('SELECT * FROM case_types WHERE is_active = 1').all();
  res.json(types);
});

app.get('/api/case-types/:id/documents', requireAuth, (req, res) => {
  const docs = db.prepare('SELECT * FROM case_type_documents WHERE case_type_id = ? ORDER BY sort_order').all(parseInt(req.params.id));
  res.json(docs);
});

// ==================== CASES ====================

app.get('/api/cases', requireAuth, (req, res) => {
  const cases = db.prepare(`
    SELECT c.*, ct.name as case_type_name,
           u1.full_name as assigned_to_name,
           u2.full_name as created_by_name
    FROM cases c
    JOIN case_types ct ON c.case_type_id = ct.id
    LEFT JOIN users u1 ON c.assigned_to = u1.id
    LEFT JOIN users u2 ON c.created_by = u2.id
    ORDER BY c.created_at DESC
  `).all();

  // Get document counts for each case
  const enriched = cases.map(c => {
    const docs = db.prepare('SELECT status FROM case_documents WHERE case_id = ?').all(c.id);
    return {
      ...c,
      total_docs: docs.length,
      accepted_docs: docs.filter(d => d.status === 'accepted').length,
      rejected_docs: docs.filter(d => d.status === 'rejected').length,
      pending_docs: docs.filter(d => d.status === 'pending').length,
    };
  });

  res.json(enriched);
});

app.get('/api/cases/:id', requireAuth, (req, res) => {
  const caseData = db.prepare(`
    SELECT c.*, ct.name as case_type_name,
           u1.full_name as assigned_to_name,
           u2.full_name as created_by_name
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
  const { case_type_id, client_name, client_email, client_phone, service_details, notes, deadline, assigned_to } = req.body;
  const client_token = crypto.randomBytes(24).toString('hex');

  const createCase = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO cases (case_type_id, client_name, client_email, client_phone, service_details, notes, deadline, assigned_to, created_by, client_token)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      parseInt(case_type_id), client_name, client_email || '', client_phone || '',
      service_details || '', notes || '', deadline || null,
      assigned_to ? parseInt(assigned_to) : null,
      req.session.user.id, client_token
    );

    const caseId = result.lastInsertRowid;

    const templateDocs = db.prepare('SELECT * FROM case_type_documents WHERE case_type_id = ? ORDER BY sort_order').all(parseInt(case_type_id));
    for (const doc of templateDocs) {
      db.prepare('INSERT INTO case_documents (case_id, document_name, description, category, is_required, sort_order) VALUES (?, ?, ?, ?, ?, ?)')
        .run(caseId, doc.document_name, doc.description || '', doc.category, doc.is_required, doc.sort_order);
    }

    db.prepare('INSERT INTO activity_log (case_id, action, details, performed_by) VALUES (?, ?, ?, ?)')
      .run(caseId, 'case_created', 'Case created for ' + client_name, req.session.user.full_name);

    return { id: caseId, client_token };
  });

  const result = createCase();
  res.json(result);
});

app.put('/api/cases/:id', requireAuth, (req, res) => {
  const { status, assigned_to, notes, deadline, client_name, client_email, client_phone, service_details } = req.body;
  const fields = [];
  const params = [];

  if (status !== undefined) { fields.push('status = ?'); params.push(status); }
  if (assigned_to !== undefined) { fields.push('assigned_to = ?'); params.push(assigned_to ? parseInt(assigned_to) : null); }
  if (notes !== undefined) { fields.push('notes = ?'); params.push(notes); }
  if (deadline !== undefined) { fields.push('deadline = ?'); params.push(deadline); }
  if (client_name !== undefined) { fields.push('client_name = ?'); params.push(client_name); }
  if (client_email !== undefined) { fields.push('client_email = ?'); params.push(client_email); }
  if (client_phone !== undefined) { fields.push('client_phone = ?'); params.push(client_phone); }
  if (service_details !== undefined) { fields.push('service_details = ?'); params.push(service_details); }

  if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });

  fields.push("updated_at = datetime('now')");
  params.push(parseInt(req.params.id));

  db.prepare(`UPDATE cases SET ${fields.join(', ')} WHERE id = ?`).run(...params);

  db.prepare('INSERT INTO activity_log (case_id, action, details, performed_by) VALUES (?, ?, ?, ?)')
    .run(parseInt(req.params.id), 'case_updated', 'Case information updated', req.session.user.full_name);

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
    if (status === 'accepted' || status === 'rejected') {
      fields.push("reviewed_at = datetime('now')");
    }
    if (status === 'uploaded') {
      fields.push("submitted_at = datetime('now')");
    }
  }
  if (status_note !== undefined) { fields.push('status_note = ?'); params.push(status_note); }
  if (file_reference !== undefined) { fields.push('file_reference = ?'); params.push(file_reference); }

  params.push(docId);
  db.prepare(`UPDATE case_documents SET ${fields.join(', ')} WHERE id = ?`).run(...params);

  db.prepare('INSERT INTO activity_log (case_id, action, details, performed_by) VALUES (?, ?, ?, ?)')
    .run(doc.case_id, 'document_status_changed',
      doc.document_name + ': ' + (status || 'updated') + (status_note ? ' - ' + status_note : ''),
      req.session.user.full_name);

  // Check if all required docs accepted
  if (status === 'accepted') {
    const pending = db.prepare("SELECT COUNT(*) as count FROM case_documents WHERE case_id = ? AND is_required = 1 AND status != 'accepted'").get(doc.case_id);
    if (pending.count === 0) {
      db.prepare("UPDATE cases SET status = 'documents_complete', updated_at = datetime('now') WHERE id = ?").run(doc.case_id);
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
    SELECT c.id, c.client_name, c.client_token, c.status, c.deadline,
           ct.name as case_type_name,
           u1.full_name as assigned_to_name
    FROM cases c
    JOIN case_types ct ON c.case_type_id = ct.id
    LEFT JOIN users u1 ON c.assigned_to = u1.id
    WHERE c.client_token = ?
  `).get(req.params.token);

  if (!caseData) return res.status(404).json({ error: 'Case not found' });

  const documents = db.prepare(`
    SELECT id, document_name, description, category, is_required, status, status_note, client_note, submitted_at, reviewed_at, sort_order
    FROM case_documents WHERE case_id = ? ORDER BY sort_order, category
  `).all(caseData.id);

  res.json({ ...caseData, documents });
});

app.put('/api/client/:token/documents/:docId/note', (req, res) => {
  const caseData = db.prepare('SELECT id FROM cases WHERE client_token = ?').get(req.params.token);
  if (!caseData) return res.status(404).json({ error: 'Case not found' });

  const docId = parseInt(req.params.docId);
  const doc = db.prepare('SELECT * FROM case_documents WHERE id = ? AND case_id = ?').get(docId, caseData.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  const { client_note } = req.body;
  db.prepare("UPDATE case_documents SET client_note = ?, updated_at = datetime('now') WHERE id = ?").run(client_note, docId);

  db.prepare('INSERT INTO activity_log (case_id, action, details, performed_by) VALUES (?, ?, ?, ?)')
    .run(caseData.id, 'client_note_added', 'Client note on ' + doc.document_name + ': ' + client_note, 'Client');

  res.json({ success: true });
});

app.put('/api/client/:token/documents/:docId/mark-sent', (req, res) => {
  const caseData = db.prepare('SELECT id FROM cases WHERE client_token = ?').get(req.params.token);
  if (!caseData) return res.status(404).json({ error: 'Case not found' });

  const docId = parseInt(req.params.docId);
  const doc = db.prepare('SELECT * FROM case_documents WHERE id = ? AND case_id = ?').get(docId, caseData.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  if (doc.status !== 'pending' && doc.status !== 'rejected') {
    return res.status(400).json({ error: 'Document cannot be marked as sent in current status' });
  }

  const { client_note } = req.body;
  db.prepare("UPDATE case_documents SET status = 'uploaded', client_note = ?, submitted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
    .run(client_note || doc.client_note || '', docId);

  db.prepare('INSERT INTO activity_log (case_id, action, details, performed_by) VALUES (?, ?, ?, ?)')
    .run(caseData.id, 'client_marked_sent', 'Client marked "' + doc.document_name + '" as sent' + (client_note ? ': ' + client_note : ''), 'Client');

  res.json({ success: true });
});

// ==================== DASHBOARD STATS ====================

app.get('/api/stats', requireAuth, (req, res) => {
  const totalCases = db.prepare('SELECT COUNT(*) as count FROM cases').get().count;
  const activeCases = db.prepare("SELECT COUNT(*) as count FROM cases WHERE status = 'active'").get().count;
  const completeCases = db.prepare("SELECT COUNT(*) as count FROM cases WHERE status = 'documents_complete'").get().count;
  const onHoldCases = db.prepare("SELECT COUNT(*) as count FROM cases WHERE status = 'on_hold'").get().count;

  const totalDocs = db.prepare('SELECT COUNT(*) as count FROM case_documents').get().count;
  const pendingDocs = db.prepare("SELECT COUNT(*) as count FROM case_documents WHERE status = 'pending'").get().count;
  const uploadedDocs = db.prepare("SELECT COUNT(*) as count FROM case_documents WHERE status = 'uploaded'").get().count;
  const acceptedDocs = db.prepare("SELECT COUNT(*) as count FROM case_documents WHERE status = 'accepted'").get().count;
  const rejectedDocs = db.prepare("SELECT COUNT(*) as count FROM case_documents WHERE status = 'rejected'").get().count;

  const recentActivity = db.prepare(`
    SELECT al.*, c.client_name
    FROM activity_log al
    LEFT JOIN cases c ON al.case_id = c.id
    ORDER BY al.created_at DESC
  `).all().slice(0, 20);

  res.json({
    cases: { total: totalCases, active: activeCases, complete: completeCases, on_hold: onHoldCases },
    documents: { total: totalDocs, pending: pendingDocs, uploaded: uploadedDocs, accepted: acceptedDocs, rejected: rejectedDocs },
    recentActivity
  });
});

// ==================== SERVE PAGES ====================

app.get('/staff', (req, res) => res.sendFile(path.join(__dirname, 'public', 'staff', 'login.html')));
app.get('/staff/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'staff', 'dashboard.html')));
app.get('/portal/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'client', 'portal.html')));

// ==================== START ====================

async function start() {
  db = await initDatabase();
  app.listen(PORT, () => {
    console.log(`\n  RP Immigration Consulting - Client Checklist System`);
    console.log(`  Server running at http://localhost:${PORT}`);
    console.log(`\n  Staff login:     http://localhost:${PORT}/staff`);
    console.log(`  Default login:   admin / admin123`);
    console.log(`\n  Client portals are accessed via unique links generated per case.\n`);
  });
}

start().catch(err => { console.error('Failed to start:', err); process.exit(1); });
