/**
 * Vaelos - Database layer (pg / PostgreSQL)
 * Schema, auth helpers, and seed data.
 */
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

// Use DATABASE_URL from environment (Neon / Vercel)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function init() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('Admin','Driver')),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        driver_id INTEGER
      );

      CREATE TABLE IF NOT EXISTS vehicles (
        id SERIAL PRIMARY KEY,
        reg_no TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        max_load_kg DOUBLE PRECISION NOT NULL,
        odometer_km DOUBLE PRECISION NOT NULL DEFAULT 0,
        acquisition_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
        region TEXT DEFAULT 'Central',
        status TEXT NOT NULL DEFAULT 'Available' CHECK (status IN ('Available','On Trip','In Shop','Retired')),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        _demo_owner TEXT
      );

      CREATE TABLE IF NOT EXISTS drivers (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        license_no TEXT UNIQUE NOT NULL,
        license_category TEXT NOT NULL,
        license_expiry DATE NOT NULL,
        contact TEXT NOT NULL,
        safety_score DOUBLE PRECISION NOT NULL DEFAULT 80.0,
        status TEXT NOT NULL DEFAULT 'Available' CHECK (status IN ('Available','On Trip','Off Duty','Suspended')),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        _demo_owner TEXT
      );

      CREATE TABLE IF NOT EXISTS trips (
        id SERIAL PRIMARY KEY,
        source TEXT NOT NULL,
        destination TEXT NOT NULL,
        vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
        driver_id INTEGER NOT NULL REFERENCES drivers(id),
        cargo_kg DOUBLE PRECISION NOT NULL,
        planned_distance_km DOUBLE PRECISION NOT NULL,
        status TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft','Dispatched','Completed','Cancelled')),
        start_odometer DOUBLE PRECISION,
        end_odometer DOUBLE PRECISION,
        fuel_used_liters DOUBLE PRECISION,
        revenue DOUBLE PRECISION DEFAULT 0,
        dispatched_at TIMESTAMP WITH TIME ZONE,
        completed_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        _demo_owner TEXT
      );

      CREATE TABLE IF NOT EXISTS maintenance (
        id SERIAL PRIMARY KEY,
        vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
        description TEXT NOT NULL,
        cost DOUBLE PRECISION NOT NULL DEFAULT 0,
        start_date DATE NOT NULL,
        end_date DATE,
        status TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open','Closed')),
        notes TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        _demo_owner TEXT
      );

      CREATE TABLE IF NOT EXISTS fuel_logs (
        id SERIAL PRIMARY KEY,
        vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
        trip_id INTEGER REFERENCES trips(id),
        liters DOUBLE PRECISION NOT NULL,
        cost DOUBLE PRECISION NOT NULL,
        log_date DATE NOT NULL,
        odometer_km DOUBLE PRECISION,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        _demo_owner TEXT
      );

      CREATE TABLE IF NOT EXISTS expenses (
        id SERIAL PRIMARY KEY,
        vehicle_id INTEGER REFERENCES vehicles(id),
        trip_id INTEGER REFERENCES trips(id),
        category TEXT NOT NULL,
        description TEXT,
        amount DOUBLE PRECISION NOT NULL,
        expense_date DATE NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        _demo_owner TEXT
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        kind TEXT NOT NULL,
        message TEXT NOT NULL,
        target_id INTEGER,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        read INTEGER NOT NULL DEFAULT 0,
        _demo_owner TEXT
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id SERIAL PRIMARY KEY,
        actor_id INTEGER,
        actor_name TEXT,
        actor_email TEXT,
        entity TEXT NOT NULL,
        entity_id INTEGER,
        action TEXT NOT NULL,
        message TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS demo_sessions (
        email TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope IN ('admin','driver','safety','finance')),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query('COMMIT');
    console.log('[vaelos] database schema initialised ok');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[vaelos] FATAL: database init failed:', err);
    throw err;
  } finally {
    client.release();
  }

  const res = await pool.query('SELECT COUNT(*) FROM users');
  if (parseInt(res.rows[0].count) === 0) {
    await seed();
  }
  await linkDriverAccounts();
  await recomputeLicenseNotifications();
}

// ============================== DEMO ISOLATION ============================== //
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

async function ensureDemoClone(email) {
  const e = String(email || '').toLowerCase();
  if (!isDemoEmail(e)) return;

  const existing = await pool.query('SELECT email FROM demo_sessions WHERE email=$1', [e]);
  if (existing.rows.length === 0) {
    const scope = DEMO_SCOPE[e];
    await pool.query('INSERT INTO demo_sessions (email, scope) VALUES ($1, $2)', [e, scope]);

    const tablesToClone = [
      { table: 'vehicles', cols: ['reg_no', 'name', 'type', 'max_load_kg', 'odometer_km', 'acquisition_cost', 'region', 'status', 'created_at'] },
      { table: 'drivers', cols: ['name', 'license_no', 'license_category', 'license_expiry', 'contact', 'safety_score', 'status', 'created_at'] },
      { table: 'maintenance', cols: ['vehicle_id', 'description', 'cost', 'start_date', 'end_date', 'status', 'notes', 'created_at'] },
      { table: 'trips', cols: ['source', 'destination', 'vehicle_id', 'driver_id', 'cargo_kg', 'planned_distance_km', 'status', 'start_odometer', 'end_odometer', 'fuel_used_liters', 'revenue', 'dispatched_at', 'completed_at', 'created_at'] },
      { table: 'fuel_logs', cols: ['vehicle_id', 'trip_id', 'liters', 'cost', 'log_date', 'odometer_km', 'created_at'] },
      { table: 'expenses', cols: ['vehicle_id', 'trip_id', 'category', 'description', 'amount', 'expense_date', 'created_at'] },
    ];

    for (const { table, cols } of tablesToClone) {
      const rows = await pool.query(`SELECT * FROM ${table} WHERE _demo_owner IS NULL`);
      for (const r of rows.rows) {
        const values = cols.map(c => r[c]);
        const placeholders = cols.map((_, i) => `$${i + 2}`).join(',');
        await pool.query(
          `INSERT INTO ${table} (_demo_owner, ${cols.join(',')}) VALUES ($1, ${placeholders})`,
          [e, ...values]
        );
      }
    }
  }
  await recomputeDemoLicenseNotifications(e);
}

async function recomputeDemoLicenseNotifications(email) {
  const e = String(email).toLowerCase();
  await pool.query(`DELETE FROM notifications WHERE _demo_owner = $1`, [e]);
  const res = await pool.query(
    `SELECT id, name, license_no, license_expiry FROM drivers WHERE _demo_owner = $1`, [e]
  );
  const today = new Date();
  const now = new Date().toISOString();
  for (const d of res.rows) {
    if (!d.license_expiry) continue;
    const exp = new Date(d.license_expiry);
    const delta = Math.floor((exp - today) / (1000 * 3600 * 24));
    if (delta < 0) {
      await pool.query(
        `INSERT INTO notifications (kind, message, target_id, created_at, read, _demo_owner) VALUES ($1,$2,$3,$4,$5,$6)`,
        ['license_expiry', `EXPIRED: ${d.name} (${d.license_no}) — expired ${-delta} days ago.`, d.id, now, 0, e]
      );
    } else if (delta <= 60) {
      await pool.query(
        `INSERT INTO notifications (kind, message, target_id, created_at, read, _demo_owner) VALUES ($1,$2,$3,$4,$5,$6)`,
        ['license_expiry', `Expiring soon: ${d.name} (${d.license_no}) — expires in ${delta} days.`, d.id, now, 0, e]
      );
    }
  }
}

async function linkDriverAccounts() {
  const res = await pool.query("SELECT id FROM drivers WHERE license_no='DL-042018'");
  if (res.rows.length > 0) {
    await pool.query("UPDATE users SET driver_id = $1 WHERE email = 'alex@vaelos.com'", [res.rows[0].id]);
  }
}

function demoFilter(email, alias) {
  const col = alias ? `${alias}._demo_owner` : '_demo_owner';
  if (isDemoEmail(email)) {
    return { where: `${col} = $1`, args: [String(email).toLowerCase()] };
  }
  return { where: `${col} IS NULL`, args: [] };
}

async function seed() {
  const nowStr = new Date().toISOString();
  const hash = (pw) => bcrypt.hashSync(pw, 10);

  const users = [
    ['Admin Vaelos', 'admin@vaelos.com', 'admin123', 'Admin'],
    ['Alex Driver',  'alex@vaelos.com',  'driver123', 'Driver'],
  ];
  for (const [n, e, p, r] of users) {
    await pool.query('INSERT INTO users (name,email,password_hash,role,created_at) VALUES ($1,$2,$3,$4,$5)',
      [n, e, hash(p), r, nowStr]);
  }

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
  for (const v of vehicles) {
    await pool.query(
      `INSERT INTO vehicles (reg_no,name,type,max_load_kg,odometer_km,acquisition_cost,region,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [...v, nowStr]
    );
  }

  const drivers = [
    ['Alex Kumar',     'DL-042018', 'LMV', days(300),  '+91-9876500011', 88.5, 'Available'],
    ['Ravi Sharma',    'DL-072021', 'HMV', days(45),   '+91-9876500022', 76.0, 'Available'],
    ['Priya Singh',    'DL-112019', 'LMV', days(-5),   '+91-9876500033', 92.0, 'Off Duty'],
    ['Mohammed Ali',   'DL-092022', 'HMV', days(720),  '+91-9876500044', 81.0, 'Available'],
    ['Neha Verma',     'DL-052020', 'LMV', days(15),   '+91-9876500055', 70.0, 'Suspended'],
  ];
  for (const d of drivers) {
    await pool.query(
      `INSERT INTO drivers (name,license_no,license_category,license_expiry,contact,safety_score,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [...d, nowStr]
    );
  }

  const v21Res = await pool.query("SELECT id FROM vehicles WHERE reg_no='VLS-21'");
  const trk21 = v21Res.rows[0].id;
  await pool.query(
    `INSERT INTO maintenance (vehicle_id,description,cost,start_date,status,notes,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [trk21, 'Brake Pad Replacement', 8500, days(0), 'Open', 'Reported squeaking noise during last trip.', nowStr]
  );

  const v5Res = await pool.query("SELECT id FROM vehicles WHERE reg_no='VLS-05'");
  const van5 = v5Res.rows[0].id;
  const dAlexRes = await pool.query("SELECT id FROM drivers WHERE license_no='DL-042018'");
  const alex = dAlexRes.rows[0].id;
  const dispAt = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
  const compAt = new Date(Date.now() - 10 * 24 * 3600 * 1000 + 6 * 3600 * 1000).toISOString();

  const tripRes = await pool.query(
    `INSERT INTO trips (source,destination,vehicle_id,driver_id,cargo_kg,planned_distance_km,status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6, 'Completed', $7) RETURNING id`,
    ['Mumbai Warehouse', 'Pune Depot', van5, alex, 420, 180, dispAt]
  );
  const tripId = tripRes.rows[0].id;

  await pool.query(
    `UPDATE trips SET start_odometer=$1, end_odometer=$2, fuel_used_liters=$3, revenue=$4, dispatched_at=$5, completed_at=$6 WHERE id=$7`,
    [12000, 12180, 22.5, 12500, dispAt, compAt, tripId]
  );

  await pool.query(
    `INSERT INTO fuel_logs (vehicle_id,trip_id,liters,cost,log_date,odometer_km,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [van5, tripId, 22.5, 2812.5, days(0), 12180, nowStr]
  );

  await pool.query(
    `INSERT INTO expenses (vehicle_id,category,description,amount,expense_date,created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
    [van5, 'Toll', 'Mumbai-Pune Expressway toll', 380, days(0), nowStr]
  );
  await pool.query(
    `INSERT INTO expenses (vehicle_id,category,description,amount,expense_date,created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
    [van5, 'Misc', 'Driver allowance', 500, days(0), nowStr]
  );
}

async function recomputeLicenseNotifications() {
  await pool.query("DELETE FROM notifications WHERE kind = 'license_expiry' AND _demo_owner IS NULL");
  const res = await pool.query('SELECT id,name,license_no,license_expiry FROM drivers WHERE _demo_owner IS NULL');
  const today = new Date();
  const now = new Date().toISOString();
  for (const d of res.rows) {
    const exp = new Date(d.license_expiry);
    const delta = Math.floor((exp - today) / (1000 * 3600 * 24));
    if (delta < 0) {
      await pool.query(
        `INSERT INTO notifications (kind,message,target_id,created_at,read) VALUES ($1,$2,$3,$4,0)`,
        ['license_expiry', `EXPIRED: ${d.name} (${d.license_no}) — expired ${-delta} days ago.`, d.id, now]
      );
    } else if (delta <= 60) {
      await pool.query(
        `INSERT INTO notifications (kind,message,target_id,created_at,read) VALUES ($1,$2,$3,$4,0)`,
        ['license_expiry', `Expiring soon: ${d.name} (${d.license_no}) — expires in ${delta} days.`, d.id, now]
      );
    }
  }
}

async function verifyUser(email, password) {
  const res = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()]);
  const u = res.rows[0];
  if (!u) return null;
  if (!bcrypt.compareSync(password, u.password_hash)) return null;
  const { password_hash, ...safe } = u;
  return safe;
}

async function writeAudit(actor, entity, entity_id, action, message) {
  await pool.query(
    `INSERT INTO audit_log (actor_id,actor_name,actor_email,entity,entity_id,action,message,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7, CURRENT_TIMESTAMP)`,
    [actor?.id || null, actor?.name || 'system', actor?.email || null, entity, entity_id || null, action, message || '']
  );
}

module.exports = {
  pool, init, verifyUser, recomputeLicenseNotifications, writeAudit,
  isDemoEmail, ensureDemoClone, demoFilter, DEMO_EMAILS, linkDriverAccounts,
};
