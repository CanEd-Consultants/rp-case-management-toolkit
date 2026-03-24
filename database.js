const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'data', 'checklist.db');
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

let db = null;

// Save database to disk periodically and on changes
function saveDb() {
  if (db) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
  }
}

// Auto-save every 10 seconds
setInterval(saveDb, 10000);

// Wrapper to make sql.js API similar to better-sqlite3
function createWrapper(database) {
  const wrapper = {
    _db: database,

    prepare(sql) {
      return {
        _sql: sql,
        _db: database,

        run(...params) {
          database.run(sql, params);
          const lastId = database.exec("SELECT last_insert_rowid() as id")[0];
          const changes = database.getRowsModified();
          saveDb();
          return {
            lastInsertRowid: lastId ? lastId.values[0][0] : 0,
            changes: changes
          };
        },

        get(...params) {
          const stmt = database.prepare(sql);
          stmt.bind(params);
          if (stmt.step()) {
            const cols = stmt.getColumnNames();
            const vals = stmt.get();
            stmt.free();
            const row = {};
            cols.forEach((c, i) => row[c] = vals[i]);
            return row;
          }
          stmt.free();
          return undefined;
        },

        all(...params) {
          const results = [];
          const stmt = database.prepare(sql);
          stmt.bind(params);
          while (stmt.step()) {
            const cols = stmt.getColumnNames();
            const vals = stmt.get();
            const row = {};
            cols.forEach((c, i) => row[c] = vals[i]);
            results.push(row);
          }
          stmt.free();
          return results;
        }
      };
    },

    exec(sql) {
      database.exec(sql);
      saveDb();
    },

    pragma(p) {
      try { database.exec(`PRAGMA ${p}`); } catch(e) {}
    },

    transaction(fn) {
      return (...args) => {
        // sql.js auto-commits, so we just run and save at the end
        const result = fn(...args);
        saveDb();
        return result;
      };
    }
  };
  return wrapper;
}

async function initDatabase() {
  const SQL = await initSqlJs();

  // Load existing database or create new
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  const wrapper = createWrapper(db);

  wrapper.pragma('journal_mode = WAL');
  wrapper.pragma('foreign_keys = ON');

  // Create tables
  wrapper.exec(`
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

  // Seed data
  seedData(wrapper);

  return wrapper;
}

function seedData(wrapper) {
  const existingTypes = wrapper.prepare('SELECT COUNT(*) as count FROM case_types').get();
  if (existingTypes.count > 0) return;

  console.log('Seeding database with initial data...');

  const adminUser = process.env.ADMIN_USERNAME || 'admin';
  const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
  const adminHash = bcrypt.hashSync(adminPass, 10);
  wrapper.prepare('INSERT OR IGNORE INTO users (username, password_hash, full_name, role) VALUES (?, ?, ?, ?)')
    .run(adminUser, adminHash, 'Administrator', 'admin');

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

  const doInserts = wrapper.transaction(() => {
    for (const ct of caseTypes) {
      const result = wrapper.prepare('INSERT INTO case_types (name, description) VALUES (?, ?)').run(ct.name, ct.description);
      const caseTypeId = result.lastInsertRowid;
      ct.documents.forEach((doc, index) => {
        wrapper.prepare('INSERT INTO case_type_documents (case_type_id, document_name, description, is_required, sort_order, category) VALUES (?, ?, ?, ?, ?, ?)')
          .run(caseTypeId, doc.name, '', doc.required, index, doc.category);
      });
    }
  });

  doInserts();
  console.log(`Seeded ${caseTypes.length} case types with document templates.`);
}

module.exports = { initDatabase };
