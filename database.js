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
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        // Make sure we can write (mkdir -p, then touch)
        fs.mkdirSync(dir, { recursive: true });
        return p;
      }
    } catch (_) { /* try next */ }
  }
  return path.join(__dirname, 'vaelos.db');
}

const DB_PATH = resolveDbPath();
console.log(`[vaelos] using database at ${DB_PATH}`);
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('Fleet Manager','Driver','Safety Officer','Financial Analyst')),
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
      entity TEXT NOT NULL,
      entity_id INTEGER,
      action TEXT NOT NULL,
      message TEXT,
      created_at TEXT NOT NULL
    );
  `);

  const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (userCount === 0) seed();
  recomputeLicenseNotifications();
}

function seed() {
  const now = new Date().toISOString().slice(0, 19);
  const hash = (pw) => bcrypt.hashSync(pw, 10);

  const users = [
    ['Admin Vaelos', 'admin@vaelos.com', 'admin123', 'Fleet Manager'],
    ['Alex Driver',  'alex@vaelos.com',  'driver123', 'Driver'],
    ['Sarah Safety', 'sarah@vaelos.com', 'safety123', 'Safety Officer'],
    ['Felix Finance','felix@vaelos.com', 'finance123', 'Financial Analyst'],
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
    `INSERT INTO audit_log (actor_id,actor_name,entity,entity_id,action,message,created_at)
     VALUES (?,?,?,?,?,?,?)`
  ).run(actor?.id || null, actor?.name || 'system', entity, entity_id || null,
        action, message || '', new Date().toISOString().slice(0, 19));
}

module.exports = { db, init, verifyUser, recomputeLicenseNotifications, writeAudit };
