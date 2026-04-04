const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

// Database path: always use local data/ directory
const dataDir = path.join(__dirname, 'data');
const DB_PATH = path.join(dataDir, 'checklist.db');
const SEED_DB_PATH = path.join(__dirname, 'seed', 'checklist.db');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// On first deploy or empty DB: copy production data from seed
if (!fs.existsSync(DB_PATH) && fs.existsSync(SEED_DB_PATH)) {
  fs.copyFileSync(SEED_DB_PATH, DB_PATH);
  console.log('Initialized database from seed (production data).');
} else if (fs.existsSync(DB_PATH) && fs.existsSync(SEED_DB_PATH)) {
  // Check if DB is essentially empty (only has auto-seeded data, not real data)
  try {
    const TestDb = require('better-sqlite3');
    const tdb = new TestDb(DB_PATH, { readonly: true });
    const userCount = tdb.prepare('SELECT COUNT(*) as c FROM users').get().c;
    tdb.close();
    if (userCount <= 1) {
      // Only admin user — replace with seed that has all production data
      fs.copyFileSync(SEED_DB_PATH, DB_PATH);
      console.log('Replaced empty database with seed (production data).');
    }
  } catch(e) {
    // DB might be corrupt or have no tables — replace
    fs.copyFileSync(SEED_DB_PATH, DB_PATH);
    console.log('Replaced invalid database with seed.');
  }
}
console.log('Database path:', DB_PATH);

async function initDatabase() {
  const db = new Database(DB_PATH);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'filing',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS case_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      is_active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS case_type_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_type_id INTEGER NOT NULL,
      document_name TEXT NOT NULL,
      description TEXT,
      is_required INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      category TEXT DEFAULT 'General',
      FOREIGN KEY (case_type_id) REFERENCES case_types(id)
    );

    CREATE TABLE IF NOT EXISTS cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_token TEXT UNIQUE NOT NULL,
      case_type_id INTEGER NOT NULL,
      client_name TEXT NOT NULL,
      client_email TEXT,
      client_phone TEXT,
      service_details TEXT,
      notes TEXT,
      deadline DATE,
      assigned_to INTEGER,
      created_by INTEGER,
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (case_type_id) REFERENCES case_types(id),
      FOREIGN KEY (assigned_to) REFERENCES users(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS case_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER NOT NULL,
      document_name TEXT NOT NULL,
      description TEXT,
      category TEXT DEFAULT 'General',
      is_required INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      status_note TEXT,
      file_reference TEXT,
      submitted_at DATETIME,
      reviewed_at DATETIME,
      client_note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (case_id) REFERENCES cases(id)
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER,
      action TEXT NOT NULL,
      details TEXT,
      performed_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (case_id) REFERENCES cases(id)
    );
  `);

  // Migrations — add columns that may not exist yet
  const migrateCaseCol = (col, def) => {
    try { db.prepare(`SELECT ${col} FROM cases LIMIT 0`).get(); }
    catch(e) { db.exec(`ALTER TABLE cases ADD COLUMN ${col} ${def}`); }
  };
  migrateCaseCol('kt_data', "TEXT DEFAULT '{}'");
  migrateCaseCol('priority', "TEXT DEFAULT 'medium'");
  migrateCaseCol('urgency_reason', "TEXT");
  migrateCaseCol('sla_deadline', "DATE");
  migrateCaseCol('stage', "TEXT DEFAULT 'new'");
  migrateCaseCol('submitted_at', "DATETIME");
  migrateCaseCol('decision', "TEXT");
  migrateCaseCol('decision_date', "DATE");
  migrateCaseCol('application_number', "TEXT");
  migrateCaseCol('crm_added', "INTEGER DEFAULT 0");
  migrateCaseCol('client_data', "TEXT DEFAULT '{}'");
  migrateCaseCol('deleted_at', "DATETIME");

  // User migrations
  const migrateUserCol = (col, def) => {
    try { db.prepare(`SELECT ${col} FROM users LIMIT 0`).get(); }
    catch(e) { db.exec(`ALTER TABLE users ADD COLUMN ${col} ${def}`); }
  };
  migrateUserCol('sort_order', "INTEGER DEFAULT 0");
  migrateUserCol('is_active', "INTEGER DEFAULT 1");

  // New tables for Module A+B
  db.exec(`
    CREATE TABLE IF NOT EXISTS case_fees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER NOT NULL,
      fee_type TEXT NOT NULL,
      amount REAL NOT NULL,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (case_id) REFERENCES cases(id)
    );

    CREATE TABLE IF NOT EXISTS case_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      payment_date DATE NOT NULL,
      payment_method TEXT,
      installment_number INTEGER,
      notes TEXT,
      recorded_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (case_id) REFERENCES cases(id),
      FOREIGN KEY (recorded_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS sla_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_type_id INTEGER NOT NULL UNIQUE,
      expected_days INTEGER NOT NULL,
      warning_days INTEGER NOT NULL,
      FOREIGN KEY (case_type_id) REFERENCES case_types(id)
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      case_id INTEGER,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      is_read INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (case_id) REFERENCES cases(id)
    );

    CREATE TABLE IF NOT EXISTS case_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      note TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (case_id) REFERENCES cases(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS case_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER NOT NULL,
      assigned_to INTEGER,
      title TEXT NOT NULL,
      due_date DATE,
      is_completed INTEGER DEFAULT 0,
      completed_at DATETIME,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (case_id) REFERENCES cases(id),
      FOREIGN KEY (assigned_to) REFERENCES users(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    );
  `);

  // Post-table-creation migrations (must run AFTER CREATE TABLE)
  const migrateSlaCol = (col, def) => {
    try { db.prepare(`SELECT ${col} FROM sla_config LIMIT 0`).get(); }
    catch(e) { db.exec(`ALTER TABLE sla_config ADD COLUMN ${col} ${def}`); }
  };
  migrateSlaCol('points', "INTEGER DEFAULT 5");

  const migrateFeeCol = (col, def) => {
    try { db.prepare(`SELECT ${col} FROM case_fees LIMIT 0`).get(); }
    catch(e) { db.exec(`ALTER TABLE case_fees ADD COLUMN ${col} ${def}`); }
  };
  migrateFeeCol('govt_fee_status', "TEXT");

  // Seed data
  seedData(db);

  return db;
}

function seedData(db) {
  const existingTypes = db.prepare('SELECT COUNT(*) as count FROM case_types').get();
  if (existingTypes.count > 0) {
    // Skip initial seed but still add new case types below
    addNewCaseTypes(db);
    return;
  }

  console.log('Seeding database with initial data...');

  const adminUser = process.env.ADMIN_USERNAME || 'admin';
  const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
  const adminHash = bcrypt.hashSync(adminPass, 10);
  db.prepare('INSERT OR IGNORE INTO users (username, password_hash, full_name, role) VALUES (?, ?, ?, ?)')
    .run(adminUser, adminHash, 'Administrator', 'admin');

  // No sample users — admin creates team members via the Team page

  const caseTypes = [
    {
      name: 'LMIA (Labour Market Impact Assessment)',
      description: 'Employer-side application for hiring foreign workers',
      documents: [
        { name: 'Business License / Registration', category: 'Employer Documents', required: 1 },
        { name: 'CRA Business Number Confirmation', category: 'Employer Documents', required: 1 },
        { name: 'Provincial/Territorial Business Registration', category: 'Employer Documents', required: 1 },
        { name: 'T4 Summary (last 2 years)', category: 'Employer Documents', required: 1 },
        { name: 'Financial Statements / T2 (last 2 years)', category: 'Employer Documents', required: 1 },
        { name: 'Job Offer Letter / Employment Contract', category: 'Job Details', required: 1 },
        { name: 'Job Description / NOC Classification', category: 'Job Details', required: 1 },
        { name: 'Recruitment Efforts Evidence', category: 'Job Details', required: 1 },
        { name: 'Wage Evidence / Prevailing Wage Research', category: 'Job Details', required: 1 },
        { name: 'Transition Plan', category: 'Job Details', required: 1 },
        { name: 'Floor Plan / Business Photos', category: 'Supporting', required: 0 },
        { name: 'Organizational Chart', category: 'Supporting', required: 0 },
      ]
    },
    {
      name: 'Open Work Permit',
      description: 'Unrestricted work authorization in Canada',
      documents: [
        { name: 'Valid Passport (all pages)', category: 'Identity', required: 1 },
        { name: 'Passport-size Photographs (2)', category: 'Identity', required: 1 },
        { name: 'Current Immigration Status Document', category: 'Immigration', required: 1 },
        { name: 'Previous Work Permits (if any)', category: 'Immigration', required: 0 },
        { name: 'Proof of Relationship (if spousal OWP)', category: 'Supporting', required: 0 },
        { name: "Spouse/Partner's Work Permit or Study Permit", category: 'Supporting', required: 0 },
        { name: 'Medical Exam Confirmation (IME)', category: 'Medical', required: 1 },
        { name: 'Police Clearance Certificate', category: 'Background', required: 1 },
        { name: 'Proof of Financial Support', category: 'Financial', required: 0 },
        { name: 'Resume / CV', category: 'Supporting', required: 0 },
      ]
    },
    {
      name: 'Employer-Specific Work Permit',
      description: 'Work permit tied to a specific employer',
      documents: [
        { name: 'Valid Passport (all pages)', category: 'Identity', required: 1 },
        { name: 'Passport-size Photographs (2)', category: 'Identity', required: 1 },
        { name: 'LMIA Approval Letter', category: 'Employment', required: 1 },
        { name: 'Job Offer Letter / Employment Contract', category: 'Employment', required: 1 },
        { name: 'Educational Credentials (degrees, diplomas)', category: 'Qualifications', required: 1 },
        { name: 'ECA Report (if applicable)', category: 'Qualifications', required: 0 },
        { name: 'Work Experience Letters', category: 'Qualifications', required: 1 },
        { name: 'Resume / CV', category: 'Qualifications', required: 1 },
        { name: 'Medical Exam Confirmation (IME)', category: 'Medical', required: 1 },
        { name: 'Police Clearance Certificate', category: 'Background', required: 1 },
        { name: 'Previous Work Permits / Visa History', category: 'Immigration', required: 0 },
        { name: 'Proof of Ties to Home Country', category: 'Supporting', required: 0 },
      ]
    },
    {
      name: 'Express Entry - Federal Skilled Worker',
      description: 'PR pathway through Express Entry FSW stream',
      documents: [
        { name: 'Valid Passport (all pages)', category: 'Identity', required: 1 },
        { name: 'Passport-size Photographs (2)', category: 'Identity', required: 1 },
        { name: 'Birth Certificate', category: 'Identity', required: 1 },
        { name: 'Marriage Certificate (if applicable)', category: 'Identity', required: 0 },
        { name: 'Language Test Results (IELTS/CELPIP/TEF)', category: 'Language', required: 1 },
        { name: 'Educational Credential Assessment (ECA)', category: 'Education', required: 1 },
        { name: 'Degrees / Diplomas / Transcripts', category: 'Education', required: 1 },
        { name: 'Work Experience Letters (all positions, last 10 years)', category: 'Employment', required: 1 },
        { name: 'Resume / CV', category: 'Employment', required: 1 },
        { name: 'Proof of Funds (bank statements, investments)', category: 'Financial', required: 1 },
        { name: 'Police Clearance Certificate (all countries lived 6+ months)', category: 'Background', required: 1 },
        { name: 'Medical Exam Confirmation (IME)', category: 'Medical', required: 1 },
        { name: 'Provincial Nomination Certificate (if PNP)', category: 'Immigration', required: 0 },
        { name: 'Spouse/Partner Documents (passport, language, education)', category: 'Family', required: 0 },
        { name: 'Dependent Children Documents (birth certificates, custody)', category: 'Family', required: 0 },
        { name: 'Reference Letters', category: 'Supporting', required: 0 },
      ]
    },
    {
      name: 'Express Entry - Canadian Experience Class',
      description: 'PR pathway for those with Canadian work experience',
      documents: [
        { name: 'Valid Passport (all pages)', category: 'Identity', required: 1 },
        { name: 'Passport-size Photographs (2)', category: 'Identity', required: 1 },
        { name: 'Birth Certificate', category: 'Identity', required: 1 },
        { name: 'Language Test Results (IELTS/CELPIP/TEF)', category: 'Language', required: 1 },
        { name: 'Canadian Work Experience Letters', category: 'Employment', required: 1 },
        { name: 'Pay Stubs / T4s from Canadian Employment', category: 'Employment', required: 1 },
        { name: 'Resume / CV', category: 'Employment', required: 1 },
        { name: 'Educational Credentials', category: 'Education', required: 1 },
        { name: 'Police Clearance Certificate', category: 'Background', required: 1 },
        { name: 'Medical Exam Confirmation (IME)', category: 'Medical', required: 1 },
        { name: 'Current/Previous Immigration Documents', category: 'Immigration', required: 1 },
        { name: 'Spouse/Partner Documents (if applicable)', category: 'Family', required: 0 },
        { name: 'Dependent Children Documents (if applicable)', category: 'Family', required: 0 },
      ]
    },
    {
      name: 'Provincial Nominee Program (PNP)',
      description: 'Provincial nomination for permanent residence',
      documents: [
        { name: 'Valid Passport (all pages)', category: 'Identity', required: 1 },
        { name: 'Passport-size Photographs (2)', category: 'Identity', required: 1 },
        { name: 'Birth Certificate', category: 'Identity', required: 1 },
        { name: 'Language Test Results (IELTS/CELPIP/TEF)', category: 'Language', required: 1 },
        { name: 'Educational Credential Assessment (ECA)', category: 'Education', required: 1 },
        { name: 'Degrees / Diplomas / Transcripts', category: 'Education', required: 1 },
        { name: 'Work Experience Letters', category: 'Employment', required: 1 },
        { name: 'Job Offer Letter (if employer-driven stream)', category: 'Employment', required: 0 },
        { name: 'Resume / CV', category: 'Employment', required: 1 },
        { name: 'Provincial Nomination Certificate', category: 'Immigration', required: 1 },
        { name: 'Settlement Plan / Connection to Province', category: 'Immigration', required: 1 },
        { name: 'Proof of Funds', category: 'Financial', required: 1 },
        { name: 'Police Clearance Certificate', category: 'Background', required: 1 },
        { name: 'Medical Exam Confirmation (IME)', category: 'Medical', required: 1 },
        { name: 'Spouse/Partner Documents (if applicable)', category: 'Family', required: 0 },
        { name: 'Dependent Children Documents (if applicable)', category: 'Family', required: 0 },
      ]
    },
    {
      name: 'Spousal / Family Sponsorship',
      description: 'Sponsoring a spouse, partner, or family member for PR',
      documents: [
        { name: 'Sponsor - Valid Passport / PR Card', category: 'Sponsor Identity', required: 1 },
        { name: 'Sponsor - Proof of Canadian Status (citizenship/PR)', category: 'Sponsor Identity', required: 1 },
        { name: 'Sponsor - Notice of Assessment (last 3 years)', category: 'Sponsor Financial', required: 1 },
        { name: 'Sponsor - T4 / Employment Letter', category: 'Sponsor Financial', required: 1 },
        { name: 'Sponsor - Statutory Declaration of Common-Law Union (if applicable)', category: 'Relationship', required: 0 },
        { name: 'Applicant - Valid Passport (all pages)', category: 'Applicant Identity', required: 1 },
        { name: 'Applicant - Passport-size Photographs (2)', category: 'Applicant Identity', required: 1 },
        { name: 'Applicant - Birth Certificate', category: 'Applicant Identity', required: 1 },
        { name: 'Marriage Certificate', category: 'Relationship', required: 1 },
        { name: 'Proof of Genuine Relationship (photos, chat logs, travel)', category: 'Relationship', required: 1 },
        { name: 'Relationship Timeline / History', category: 'Relationship', required: 1 },
        { name: 'Applicant - Police Clearance Certificate', category: 'Background', required: 1 },
        { name: 'Applicant - Medical Exam Confirmation (IME)', category: 'Medical', required: 1 },
        { name: 'Dependent Children Documents (if applicable)', category: 'Family', required: 0 },
        { name: 'Divorce / Annulment Papers (if previously married)', category: 'Supporting', required: 0 },
      ]
    },
    {
      name: 'Study Permit',
      description: 'Authorization to study in Canada',
      documents: [
        { name: 'Valid Passport (all pages)', category: 'Identity', required: 1 },
        { name: 'Passport-size Photographs (2)', category: 'Identity', required: 1 },
        { name: 'Letter of Acceptance from DLI', category: 'Education', required: 1 },
        { name: 'Proof of Tuition Payment / Receipt', category: 'Education', required: 1 },
        { name: 'Previous Academic Transcripts / Diplomas', category: 'Education', required: 1 },
        { name: 'Statement of Purpose / Study Plan', category: 'Education', required: 1 },
        { name: 'Proof of Funds (bank statements, GIC, sponsor letter)', category: 'Financial', required: 1 },
        { name: "Sponsor's Financial Documents (if funded by family)", category: 'Financial', required: 0 },
        { name: 'Language Test Results (IELTS/TOEFL)', category: 'Language', required: 1 },
        { name: 'Medical Exam Confirmation (IME)', category: 'Medical', required: 0 },
        { name: 'Police Clearance Certificate', category: 'Background', required: 1 },
        { name: 'Proof of Ties to Home Country', category: 'Supporting', required: 1 },
        { name: 'Provincial Attestation Letter (PAL)', category: 'Immigration', required: 1 },
      ]
    },
    {
      name: 'Visitor Visa / Super Visa',
      description: 'Temporary resident visa for visiting Canada',
      documents: [
        { name: 'Valid Passport (all pages)', category: 'Identity', required: 1 },
        { name: 'Passport-size Photographs (2)', category: 'Identity', required: 1 },
        { name: 'Invitation Letter from Host in Canada', category: 'Supporting', required: 1 },
        { name: "Host's Proof of Status in Canada", category: 'Supporting', required: 1 },
        { name: "Host's Financial Documents (NOA, pay stubs)", category: 'Supporting', required: 0 },
        { name: 'Proof of Funds / Bank Statements', category: 'Financial', required: 1 },
        { name: 'Employment Letter / Business Registration', category: 'Employment', required: 1 },
        { name: 'Proof of Ties to Home Country', category: 'Supporting', required: 1 },
        { name: 'Travel History (previous visas, stamps)', category: 'Immigration', required: 0 },
        { name: 'Travel Itinerary / Return Ticket', category: 'Supporting', required: 0 },
        { name: 'Medical Insurance (mandatory for Super Visa)', category: 'Medical', required: 0 },
        { name: 'Medical Exam Confirmation (Super Visa only)', category: 'Medical', required: 0 },
        { name: 'Police Clearance Certificate', category: 'Background', required: 0 },
      ]
    },
    {
      name: 'Citizenship Application',
      description: 'Application for Canadian citizenship',
      documents: [
        { name: 'Valid Passport (all pages)', category: 'Identity', required: 1 },
        { name: 'PR Card (front and back)', category: 'Identity', required: 1 },
        { name: 'Passport-size Photographs (2)', category: 'Identity', required: 1 },
        { name: 'Birth Certificate', category: 'Identity', required: 1 },
        { name: 'Landing Paper / COPR', category: 'Immigration', required: 1 },
        { name: 'All Travel Documents Used to Enter Canada', category: 'Immigration', required: 1 },
        { name: 'Tax Returns / NOA (last 5 years)', category: 'Financial', required: 1 },
        { name: 'Proof of Physical Presence in Canada', category: 'Residence', required: 1 },
        { name: 'Travel History (absences from Canada)', category: 'Residence', required: 1 },
        { name: 'Language Proof (CLB 4+ or test results)', category: 'Language', required: 1 },
        { name: 'Residential Address History', category: 'Residence', required: 1 },
        { name: 'Employment / Education History in Canada', category: 'Employment', required: 1 },
      ]
    },
    {
      name: 'PR Card Renewal',
      description: 'Renewal of Permanent Resident Card',
      documents: [
        { name: 'Current PR Card (even if expired)', category: 'Identity', required: 1 },
        { name: 'Valid Passport (all pages)', category: 'Identity', required: 1 },
        { name: 'Passport-size Photographs (2)', category: 'Identity', required: 1 },
        { name: 'Landing Paper / COPR', category: 'Immigration', required: 1 },
        { name: 'All Passports Used During PR Period', category: 'Immigration', required: 1 },
        { name: 'Proof of Physical Presence (730 days in 5 years)', category: 'Residence', required: 1 },
        { name: 'Travel History / Entry-Exit Records', category: 'Residence', required: 1 },
        { name: 'Tax Returns / NOA (last 5 years)', category: 'Financial', required: 1 },
        { name: 'Residential Address History', category: 'Residence', required: 1 },
        { name: 'Employment History in Canada', category: 'Employment', required: 0 },
      ]
    },
  ];

  const doInserts = db.transaction(() => {
    for (const ct of caseTypes) {
      const result = db.prepare('INSERT INTO case_types (name, description) VALUES (?, ?)').run(ct.name, ct.description);
      const caseTypeId = result.lastInsertRowid;
      ct.documents.forEach((doc, index) => {
        db.prepare('INSERT INTO case_type_documents (case_type_id, document_name, description, is_required, sort_order, category) VALUES (?, ?, ?, ?, ?, ?)')
          .run(caseTypeId, doc.name, '', doc.required, index, doc.category);
      });
    }
  });

  doInserts();
  console.log(`Seeded ${caseTypes.length} case types with document templates.`);

  // Seed SLA config if empty
  const existingSLA = db.prepare('SELECT COUNT(*) as count FROM sla_config').get();
  if (existingSLA.count === 0) {
    const slaDefaults = [
      // case_type_id, expected_days, warning_days
      [1, 30, 21],   // LMIA
      [2, 21, 14],   // Open Work Permit
      [3, 21, 14],   // Employer-Specific WP
      [4, 45, 30],   // Express Entry FSW
      [5, 45, 30],   // Express Entry CEC
      [6, 45, 30],   // PNP
      [7, 60, 45],   // Spousal / Family Sponsorship
      [8, 21, 14],   // Study Permit
      [9, 14, 10],   // Visitor Visa / Super Visa
      [10, 30, 21],  // Citizenship
      [11, 21, 14],  // PR Card Renewal
    ];
    const insertSLA = db.prepare('INSERT OR IGNORE INTO sla_config (case_type_id, expected_days, warning_days) VALUES (?, ?, ?)');
    slaDefaults.forEach(s => insertSLA.run(...s));
    console.log('Seeded SLA configuration defaults.');
  }

  addNewCaseTypes(db);
}

function addNewCaseTypes(db) {
  // Add new case types if they don't exist (added post-launch)
  const newCaseTypes = [
    {
      name: 'PGWP (Post-Graduation Work Permit)',
      description: 'Work permit for international graduates',
      documents: [
        { name: 'Valid Passport (all pages)', category: 'Identity', required: 1 },
        { name: 'Passport-size Photographs (2)', category: 'Identity', required: 1 },
        { name: 'Study Permit (current)', category: 'Immigration', required: 1 },
        { name: 'Letter of Completion from DLI', category: 'Education', required: 1 },
        { name: 'Official Transcripts', category: 'Education', required: 1 },
        { name: 'DLI Confirmation of Program Completion', category: 'Education', required: 1 },
        { name: 'Resume / CV', category: 'Supporting', required: 0 },
      ],
      sla: [14, 10, 3]
    },
    {
      name: 'Bridging Work Permit',
      description: 'Work permit while waiting for PR decision',
      documents: [
        { name: 'Valid Passport (all pages)', category: 'Identity', required: 1 },
        { name: 'Passport-size Photographs (2)', category: 'Identity', required: 1 },
        { name: 'Current Work Permit', category: 'Immigration', required: 1 },
        { name: 'Proof of PR Application Submitted', category: 'Immigration', required: 1 },
        { name: 'Current Employer Letter', category: 'Employment', required: 1 },
        { name: 'Medical Exam (if applicable)', category: 'Medical', required: 0 },
      ],
      sla: [14, 10, 3]
    },
    {
      name: 'PGWP Extension',
      description: 'Extension of post-graduation work permit',
      documents: [
        { name: 'Valid Passport (all pages)', category: 'Identity', required: 1 },
        { name: 'Passport-size Photographs (2)', category: 'Identity', required: 1 },
        { name: 'Current PGWP', category: 'Immigration', required: 1 },
        { name: 'Employer Letter / Job Offer', category: 'Employment', required: 1 },
        { name: 'Pay Stubs / T4', category: 'Employment', required: 0 },
      ],
      sla: [14, 10, 3]
    },
    {
      name: 'Study Permit Extension',
      description: 'Extension of study permit',
      documents: [
        { name: 'Valid Passport (all pages)', category: 'Identity', required: 1 },
        { name: 'Passport-size Photographs (2)', category: 'Identity', required: 1 },
        { name: 'Current Study Permit', category: 'Immigration', required: 1 },
        { name: 'Letter of Acceptance (new or continuing)', category: 'Education', required: 1 },
        { name: 'Proof of Enrollment', category: 'Education', required: 1 },
        { name: 'Proof of Funds', category: 'Financial', required: 1 },
        { name: 'Transcripts', category: 'Education', required: 1 },
      ],
      sla: [14, 10, 3]
    },
    {
      name: 'Work Permit Extension',
      description: 'Extension of employer-specific or open work permit',
      documents: [
        { name: 'Valid Passport (all pages)', category: 'Identity', required: 1 },
        { name: 'Passport-size Photographs (2)', category: 'Identity', required: 1 },
        { name: 'Current Work Permit', category: 'Immigration', required: 1 },
        { name: 'LMIA (if employer-specific)', category: 'Employment', required: 0 },
        { name: 'Job Offer Letter / Employment Contract', category: 'Employment', required: 1 },
        { name: 'Employer Compliance Fee Receipt', category: 'Employment', required: 0 },
      ],
      sla: [21, 14, 4]
    },
    {
      name: 'Co-op Work Permit',
      description: 'Work permit for co-op or internship programs',
      documents: [
        { name: 'Valid Passport (all pages)', category: 'Identity', required: 1 },
        { name: 'Passport-size Photographs (2)', category: 'Identity', required: 1 },
        { name: 'Valid Study Permit', category: 'Immigration', required: 1 },
        { name: 'Letter from DLI confirming co-op requirement', category: 'Education', required: 1 },
        { name: 'Co-op Offer Letter', category: 'Employment', required: 1 },
      ],
      sla: [14, 10, 3]
    },
  ];

  newCaseTypes.forEach(ct => {
    const existing = db.prepare('SELECT id FROM case_types WHERE name = ?').get(ct.name);
    if (!existing) {
      const result = db.prepare('INSERT INTO case_types (name, description) VALUES (?, ?)').run(ct.name, ct.description);
      const caseTypeId = result.lastInsertRowid;
      ct.documents.forEach((doc, index) => {
        db.prepare('INSERT INTO case_type_documents (case_type_id, document_name, description, is_required, sort_order, category) VALUES (?, ?, ?, ?, ?, ?)')
          .run(caseTypeId, doc.name, '', doc.required, index, doc.category);
      });
      db.prepare('INSERT OR IGNORE INTO sla_config (case_type_id, expected_days, warning_days, points) VALUES (?, ?, ?, ?)')
        .run(caseTypeId, ct.sla[0], ct.sla[1], ct.sla[2]);
      console.log(`Added case type: ${ct.name}`);
    }
  });
}

module.exports = { initDatabase };
