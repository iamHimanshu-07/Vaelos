/**
 * Vaelos - Database layer (better-sqlite3)
 * Schema, auth helpers, and seed data.
 */
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

// On Railway (and other PaaS), persistent disk is only available under a
// mounted Volume. If VAELOS_DB is set explicitly, honour it. Otherwise try a
// list of likely Volume mount points in order, and fall back to the working
// directory so local dev / first deploy without a volume still works.
function resolveDbPath() {
  if (process.env.VAELOS_DB) return process.env.VAELOS_DB;
  const candidates = [
    '/data/vaelos.db',
    '/app/data/vaelos.db',
    '/mnt/vaelos.db',
    path.join(__dirname, 'vaelos.db'),
  ];
  for (const p of candidates) {
    try {
      const dir = path.dirname(p);
      // Make sure the parent dir exists (Railway mounts /data as an empty
      // directory on first boot — we need to write into it immediately).
      fs.mkdirSync(dir, { recursive: true });
      // Verify we can write (Railway volumes are writable, project dir on
      // Railway's runtime image may be read-only — this filters both).
      fs.accessSync(dir, fs.constants.W_OK);
      return p;
    } catch (_) { /* try next */ }
  }
  return path.join(__dirname, 'vaelos.db');
}

const DB_PATH = resolveDbPath();
console.log(`[vaelos] using database at ${DB_PATH}`);

let db;
try {
  db = new Database(DB_PATH);
} catch (err) {
  // Last-resort fallback: use /tmp which is always writable on Linux.
  // Not persistent across redeploys, but keeps the app alive so the user
  // can at least see a working dashboard while debugging the volume.
  const fallback = '/tmp/vaelos.db';
  console.error(`[vaelos] FATAL: cannot open ${DB_PATH}: ${err.message}`);
  console.error(`[vaelos] falling back to ephemeral ${fallback}`);
  try {
    fs.mkdirSync('/tmp', { recursive: true });
    db = new Database(fallback);
  } catch (err2) {
    console.error(`[vaelos] FATAL: even /tmp failed: ${err2.message}`);
    throw err2;
  }
}

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('Fleet Manager','Driver')),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS vehicles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reg_no TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      max_load_kg REAL NOT NULL,
      odometer_km REAL NOT NULL DEFAULT 0,
      acquisition_cost REAL NOT NULL DEFAULT 0,
      region TEXT DEFAULT 'Central',
      status TEXT NOT NULL DEFAULT 'Available' CHECK (status IN ('Available','On Trip','In Shop','Retired')),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS drivers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      license_no TEXT UNIQUE NOT NULL,
      license_category TEXT NOT NULL,
      license_expiry TEXT NOT NULL,
      contact TEXT NOT NULL,
      safety_score REAL NOT NULL DEFAULT 80.0,
      status TEXT NOT NULL DEFAULT 'Available' CHECK (status IN ('Available','On Trip','Off Duty','Suspended')),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      destination TEXT NOT NULL,
      vehicle_id INTEGER NOT NULL,
      driver_id INTEGER NOT NULL,
      cargo_kg REAL NOT NULL,
      planned_distance_km REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft','Dispatched','Completed','Cancelled')),
      start_odometer REAL,
      end_odometer REAL,
      fuel_used_liters REAL,
      revenue REAL DEFAULT 0,
      dispatched_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (vehicle_id) REFERENCES vehicles(id),
      FOREIGN KEY (driver_id) REFERENCES drivers(id)
    );

    CREATE TABLE IF NOT EXISTS maintenance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_id INTEGER NOT NULL,
      description TEXT NOT NULL,
      cost REAL NOT NULL DEFAULT 0,
      start_date TEXT NOT NULL,
      end_date TEXT,
      status TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open','Closed')),
      notes TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (vehicle_id) REFERENCES vehicles(id)
    );

    CREATE TABLE IF NOT EXISTS fuel_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_id INTEGER NOT NULL,
      trip_id INTEGER,
      liters REAL NOT NULL,
      cost REAL NOT NULL,
      log_date TEXT NOT NULL,
      odometer_km REAL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (vehicle_id) REFERENCES vehicles(id),
      FOREIGN KEY (trip_id) REFERENCES trips(id)
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_id INTEGER,
      trip_id INTEGER,
      category TEXT NOT NULL,
      description TEXT,
      amount REAL NOT NULL,
      expense_date TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (vehicle_id) REFERENCES vehicles(id),
      FOREIGN KEY (trip_id) REFERENCES trips(id)
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      target_id INTEGER,
      created_at TEXT NOT NULL,
      read INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id INTEGER,
      actor_name TEXT,
      actor_email TEXT,
      entity TEXT NOT NULL,
      entity_id INTEGER,
      action TEXT NOT NULL,
      message TEXT,
      created_at TEXT NOT NULL
    );

    -- Demo isolation: each demo login gets its own starter-fleet clone.
    -- Rows in vehicles/drivers/trips/fuel_logs/expenses/maintenance carry
    -- _demo_owner = NULL for real data, or the demo user's email when the
    -- row belongs to that user's ephemeral workspace.
    CREATE TABLE IF NOT EXISTS demo_sessions (
      email TEXT PRIMARY KEY,
      scope TEXT NOT NULL CHECK (scope IN ('admin','driver','safety','finance')),
      created_at TEXT NOT NULL
    );
  `);

  // Idempotent column adds for older DBs.
  for (const stmt of [
    "ALTER TABLE audit_log ADD COLUMN actor_email TEXT",
    "ALTER TABLE vehicles ADD COLUMN _demo_owner TEXT",
    "ALTER TABLE drivers ADD COLUMN _demo_owner TEXT",
    "ALTER TABLE trips ADD COLUMN _demo_owner TEXT",
    "ALTER TABLE fuel_logs ADD COLUMN _demo_owner TEXT",
    "ALTER TABLE expenses ADD COLUMN _demo_owner TEXT",
    "ALTER TABLE maintenance ADD COLUMN _demo_owner TEXT",
    "ALTER TABLE users ADD COLUMN driver_id INTEGER",
  ]) {
    try { db.exec(stmt); } catch (_) { /* column already exists */ }
  }

  const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (userCount === 0) seed();
  // Wire alex@vaelos.com → seeded driver Alex Kumar so the Driver role
  // demo can actually log fuel/expenses against their assigned vehicle.
  linkDriverAccounts();
  recomputeLicenseNotifications();
}

// ============================== DEMO ISOLATION ============================== //
// Demo accounts (admin, alex, sarah, felix) live in a shared DB but each
// visitor who logs in with one of them gets their own ephemeral clone of
// the starter fleet. Real signups see the canonical (non-demo) data.
const DEMO_EMAILS = new Set([
  'admin@vaelos.com',
  'alex@vaelos.com',
]);
const DEMO_SCOPE = {
  'admin@vaelos.com':   'admin',
  'alex@vaelos.com':    'driver',
};
function isDemoEmail(email) {
  return email && DEMO_EMAILS.has(String(email).toLowerCase());
}
function ensureDemoClone(email) {
  const e = String(email || '').toLowerCase();
  if (!isDemoEmail(e)) return;
  const existing = db.prepare('SELECT email FROM demo_sessions WHERE email=?').get(e);
  if (existing) return; // already cloned for this email
  const now = new Date().toISOString().slice(0, 19);
  const scope = DEMO_SCOPE[e];
  db.prepare('INSERT INTO demo_sessions (email, scope, created_at) VALUES (?,?,?)')
    .run(e, scope, now);

  // Clone the seed rows (those with _demo_owner IS NULL) so each demo email
  // sees its own copy. Idempotent: only rows where _demo_owner IS NULL
  // are duplicated; subsequent clones are skipped.
  const clone = (table, idCol, rowMapper) => {
    const rows = db.prepare(`SELECT * FROM ${table} WHERE _demo_owner IS NULL`).all();
    for (const r of rows) {
      const mapped = rowMapper(r);
      db.prepare(
        `INSERT INTO ${table} (_demo_owner, ${Object.keys(mapped).join(',')})` +
        ` VALUES (?, ${Object.keys(mapped).map(() => '?').join(',')})`
      ).run(e, ...Object.values(mapped));
    }
  };

  clone('vehicles', 'id', (v) => ({
    reg_no: v.reg_no, name: v.name, type: v.type,
    max_load_kg: v.max_load_kg, odometer_km: v.odometer_km,
    acquisition_cost: v.acquisition_cost, region: v.region,
    status: v.status, created_at: v.created_at,
  }));
  clone('drivers', 'id', (d) => ({
    name: d.name, license_no: d.license_no, license_category: d.license_category,
    license_expiry: d.license_expiry, contact: d.contact,
    safety_score: d.safety_score, status: d.status, created_at: d.created_at,
  }));
  clone('maintenance', 'id', (m) => ({
    vehicle_id: m.vehicle_id, description: m.description, cost: m.cost,
    start_date: m.start_date, end_date: m.end_date, status: m.status,
    notes: m.notes, created_at: m.created_at,
  }));
  clone('trips', 'id', (t) => ({
    source: t.source, destination: t.destination, vehicle_id: t.vehicle_id,
    driver_id: t.driver_id, cargo_kg: t.cargo_kg,
    planned_distance_km: t.planned_distance_km, status: t.status,
    start_odometer: t.start_odometer, end_odometer: t.end_odometer,
    fuel_used_liters: t.fuel_used_liters, revenue: t.revenue,
    dispatched_at: t.dispatched_at, completed_at: t.completed_at,
    created_at: t.created_at,
  }));
  clone('fuel_logs', 'id', (f) => ({
    vehicle_id: f.vehicle_id, trip_id: f.trip_id, liters: f.liters,
    cost: f.cost, log_date: f.log_date, odometer_km: f.odometer_km,
    created_at: f.created_at,
  }));
  clone('expenses', 'id', (x) => ({
    vehicle_id: x.vehicle_id, trip_id: x.trip_id, category: x.category,
    description: x.description, amount: x.amount, expense_date: x.expense_date,
    created_at: x.created_at,
  }));
}

function linkDriverAccounts() {
  // Map alex@vaelos.com → seeded driver Alex Kumar so the demo Driver
  // account can post fuel/expenses against their assigned vehicle.
  const driver = db.prepare("SELECT id FROM drivers WHERE license_no='DL-042018'").get();
  if (driver) {
    db.prepare("UPDATE users SET driver_id = ? WHERE email = 'alex@vaelos.com'")
      .run(driver.id);
  }
}

// demoFilter(email, alias='_demo_owner'):
// Returns { where, args } where the filter is fully qualified so it works in
// JOINs where multiple tables carry the column. Pass the primary table's
// alias so the prefix is correct; default '_demo_owner' resolves on
// single-table queries.
function demoFilter(email, alias) {
  const col = alias ? `${alias}._demo_owner` : '_demo_owner';
  if (isDemoEmail(email)) {
    return { where: `${col} = ?`, args: [String(email).toLowerCase()] };
  }
  return { where: `${col} IS NULL`, args: [] };
}

function seed() {
  const now = new Date().toISOString().slice(0, 19);
  const hash = (pw) => bcrypt.hashSync(pw, 10);

  const users = [
    ['Admin Vaelos', 'admin@vaelos.com', 'admin123', 'Fleet Manager'],
    ['Alex Driver',  'alex@vaelos.com',  'driver123', 'Driver'],
  ];
  const insUser = db.prepare(
    'INSERT INTO users (name,email,password_hash,role,created_at) VALUES (?,?,?,?,?)'
  );
  for (const [n, e, p, r] of users) insUser.run(n, e, hash(p), r, now);

  const today = new Date();
  const days = (n) => {
    const d = new Date(today);
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  };

  const vehicles = [
    ['VLS-05', 'Vaelos Transit Van',  'Van',   500, 12500, 18000,  'Central', 'Available'],
    ['VLS-12', 'Vaelos Cargo Truck',  'Truck', 2500, 45200, 78000,  'North',   'Available'],
    ['VLS-09', 'Vaelos Express Van',  'Van',   750,  8900,  22000,  'South',   'Available'],
    ['VLS-21', 'Vaelos Haul Master',  'Truck', 5000, 78100, 145000, 'West',    'In Shop'],
    ['VLS-03', 'Vaelos City Cruiser', 'Car',   400,  32000, 9500,   'Central', 'Available'],
  ];
  const insV = db.prepare(
    `INSERT INTO vehicles
     (reg_no,name,type,max_load_kg,odometer_km,acquisition_cost,region,status,created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );
  for (const v of vehicles) insV.run(...v, now);

  const drivers = [
    ['Alex Kumar',     'DL-042018', 'LMV', days(300),  '+91-9876500011', 88.5, 'Available'],
    ['Ravi Sharma',    'DL-072021', 'HMV', days(45),   '+91-9876500022', 76.0, 'Available'],
    ['Priya Singh',    'DL-112019', 'LMV', days(-5),   '+91-9876500033', 92.0, 'Off Duty'],
    ['Mohammed Ali',   'DL-092022', 'HMV', days(720),  '+91-9876500044', 81.0, 'Available'],
    ['Neha Verma',     'DL-052020', 'LMV', days(15),   '+91-9876500055', 70.0, 'Suspended'],
  ];
  const insD = db.prepare(
    `INSERT INTO drivers
     (name,license_no,license_category,license_expiry,contact,safety_score,status,created_at)
     VALUES (?,?,?,?,?,?,?,?)`
  );
  for (const d of drivers) insD.run(...d, now);

  const trk21 = db.prepare("SELECT id FROM vehicles WHERE reg_no='VLS-21'").get().id;
  db.prepare(
    `INSERT INTO maintenance
     (vehicle_id,description,cost,start_date,end_date,status,notes,created_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(trk21, 'Brake Pad Replacement', 8500, days(0), null, 'Open',
        'Reported squeaking noise during last trip.', now);

  const van5 = db.prepare("SELECT id FROM vehicles WHERE reg_no='VLS-05'").get().id;
  const alex = db.prepare("SELECT id FROM drivers WHERE license_no='DL-042018'").get().id;
  const dispAt = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString().slice(0, 19);
  const compAt = new Date(Date.now() - 10 * 24 * 3600 * 1000 + 6 * 3600 * 1000).toISOString().slice(0, 19);
  const tripRes = db.prepare(
    `INSERT INTO trips
     (source,destination,vehicle_id,driver_id,cargo_kg,planned_distance_km,status,
      start_odometer,end_odometer,fuel_used_liters,revenue,dispatched_at,completed_at,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run('Mumbai Warehouse', 'Pune Depot', van5, alex, 420, 180, 'Completed',
        12000, 12180, 22.5, 12500, dispAt, compAt, dispAt);

  db.prepare(
    `INSERT INTO fuel_logs
     (vehicle_id,trip_id,liters,cost,log_date,odometer_km,created_at)
     VALUES (?,?,?,?,?,?,?)`
  ).run(van5, tripRes.lastInsertRowid, 22.5, 2812.5, days(0), 12180, now);

  db.prepare(
    `INSERT INTO expenses
     (vehicle_id,category,description,amount,expense_date,created_at)
     VALUES (?,?,?,?,?,?)`
  ).run(van5, 'Toll', 'Mumbai-Pune Expressway toll', 380, days(0), now);
  db.prepare(
    `INSERT INTO expenses
     (vehicle_id,category,description,amount,expense_date,created_at)
     VALUES (?,?,?,?,?,?)`
  ).run(van5, 'Misc', 'Driver allowance', 500, days(0), now);
}

function recomputeLicenseNotifications() {
  db.prepare("DELETE FROM notifications WHERE kind = 'license_expiry'").run();
  const drivers = db.prepare('SELECT id,name,license_no,license_expiry FROM drivers').all();
  const today = new Date();
  const ins = db.prepare(
    `INSERT INTO notifications (kind,message,target_id,created_at,read)
     VALUES (?,?,?,?,0)`
  );
  const now = new Date().toISOString().slice(0, 19);
  for (const d of drivers) {
    const exp = new Date(d.license_expiry);
    const delta = Math.floor((exp - today) / (1000 * 3600 * 24));
    if (delta < 0) {
      ins.run('license_expiry',
        `EXPIRED: ${d.name} (${d.license_no}) — expired ${-delta} days ago.`,
        d.id, now);
    } else if (delta <= 60) {
      ins.run('license_expiry',
        `Expiring soon: ${d.name} (${d.license_no}) — expires in ${delta} days.`,
        d.id, now);
    }
  }
}

function verifyUser(email, password) {
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (!u) return null;
  if (!bcrypt.compareSync(password, u.password_hash)) return null;
  const { password_hash, ...safe } = u;
  return safe;
}

function writeAudit(actor, entity, entity_id, action, message) {
  db.prepare(
    `INSERT INTO audit_log (actor_id,actor_name,actor_email,entity,entity_id,action,message,created_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(actor?.id || null, actor?.name || 'system', actor?.email || null,
        entity, entity_id || null,
        action, message || '', new Date().toISOString().slice(0, 19));
}

module.exports = {
  db, init, verifyUser, recomputeLicenseNotifications, writeAudit,
  isDemoEmail, ensureDemoClone, demoFilter, DEMO_EMAILS, linkDriverAccounts,
};
