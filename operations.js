/**
 * Vaelos - Business logic / operations layer.
 * All required business rules live here.
 */
const { db, recomputeLicenseNotifications, writeAudit } = require('./database');

const now = () => new Date().toISOString().slice(0, 19);

function audit(ctx, entity, entity_id, action, message) {
  writeAudit(ctx?.user || null, entity, entity_id, action, message);
}

// ============================== USERS ============================== //
function listUsers() {
  return db.prepare('SELECT id,name,email,role,created_at FROM users ORDER BY id').all();
}
function addUser(ctx, { name, email, password, role }) {
  const bcrypt = require('bcryptjs');
  const hash = bcrypt.hashSync(password, 10);
  const r = db.prepare(
    'INSERT INTO users (name,email,password_hash,role,created_at) VALUES (?,?,?,?,?)'
  ).run(name.trim(), email.toLowerCase().trim(), hash, role, now());
  audit(ctx, 'user', r.lastInsertRowid, 'create', `Created user ${email}`);
}
function deleteUser(ctx, id) {
  const u = db.prepare('SELECT email FROM users WHERE id=?').get(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  audit(ctx, 'user', id, 'delete', `Deleted user ${u?.email}`);
}

// ============================== VEHICLES ============================== //
function listVehicles(filters = {}) {
  let q = 'SELECT * FROM vehicles WHERE 1=1';
  const args = [];
  if (filters.type && filters.type !== 'All')   { q += ' AND type = ?';   args.push(filters.type); }
  if (filters.status && filters.status !== 'All'){q += ' AND status = ?'; args.push(filters.status); }
  if (filters.region && filters.region !== 'All'){q += ' AND region = ?'; args.push(filters.region); }
  q += ' ORDER BY reg_no';
  const vehicles = db.prepare(q).all(...args);
  // Decorate each vehicle with `current_load_kg`: the cargo carried on a
  // currently-Dispatched trip, or 0 when the vehicle is idle.
  const loadByVehicle = db.prepare(
    `SELECT vehicle_id, COALESCE(SUM(cargo_kg),0) c
       FROM trips WHERE status='Dispatched' GROUP BY vehicle_id`
  ).all();
  const loadMap = Object.fromEntries(loadByVehicle.map(r => [r.vehicle_id, r.c]));
  for (const v of vehicles) v.current_load_kg = loadMap[v.id] || 0;
  return vehicles;
}
function getVehicle(id) { return db.prepare('SELECT * FROM vehicles WHERE id = ?').get(id); }
function addVehicle(ctx, { reg_no, name, type, max_load_kg, odometer_km, acquisition_cost, region }) {
  const r = db.prepare(
    `INSERT INTO vehicles
     (reg_no,name,type,max_load_kg,odometer_km,acquisition_cost,region,status,created_at)
     VALUES (?,?,?,?,?,?,?, 'Available', ?)`
  ).run(reg_no.toUpperCase().trim(), name.trim(), type, +max_load_kg,
        +odometer_km, +acquisition_cost, region, now());
  audit(ctx, 'vehicle', r.lastInsertRowid, 'create',
        `Registered vehicle ${reg_no.toUpperCase()} (${name})`);
}
function updateVehicle(ctx, id, fields) {
  const allowed = ['name','type','max_load_kg','odometer_km','acquisition_cost','region','status'];
  const sets = []; const args = [];
  for (const k of allowed) { if (k in fields) { sets.push(`${k} = ?`); args.push(fields[k]); } }
  if (!sets.length) return;
  args.push(id);
  db.prepare(`UPDATE vehicles SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  audit(ctx, 'vehicle', id, 'update', `Updated ${Object.keys(fields).join(', ')}`);
}
function deleteVehicle(ctx, id) {
  const v = db.prepare('SELECT reg_no FROM vehicles WHERE id=?').get(id);
  db.prepare('DELETE FROM vehicles WHERE id = ?').run(id);
  audit(ctx, 'vehicle', id, 'delete', `Deleted vehicle ${v?.reg_no}`);
}

// ============================== DRIVERS ============================== //
function listDrivers(filters = {}) {
  let q = 'SELECT * FROM drivers WHERE 1=1';
  const args = [];
  if (filters.status && filters.status !== 'All') { q += ' AND status = ?'; args.push(filters.status); }
  q += ' ORDER BY name';
  return db.prepare(q).all(...args);
}
function getDriver(id) { return db.prepare('SELECT * FROM drivers WHERE id = ?').get(id); }
function addDriver(ctx, { name, license_no, license_category, license_expiry, contact, safety_score }) {
  const r = db.prepare(
    `INSERT INTO drivers
     (name,license_no,license_category,license_expiry,contact,safety_score,status,created_at)
     VALUES (?,?,?,?,?,?,'Available',?)`
  ).run(name.trim(), license_no.toUpperCase().trim(), license_category,
        license_expiry, contact.trim(), +safety_score, now());
  recomputeLicenseNotifications();
  audit(ctx, 'driver', r.lastInsertRowid, 'create', `Added driver ${name}`);
}
function updateDriver(ctx, id, fields) {
  const allowed = ['name','license_category','license_expiry','contact','safety_score','status'];
  const sets = []; const args = [];
  for (const k of allowed) { if (k in fields) { sets.push(`${k} = ?`); args.push(fields[k]); } }
  if (!sets.length) return;
  args.push(id);
  db.prepare(`UPDATE drivers SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  recomputeLicenseNotifications();
  audit(ctx, 'driver', id, 'update', `Updated ${Object.keys(fields).join(', ')}`);
}
function deleteDriver(ctx, id) {
  const d = db.prepare('SELECT name FROM drivers WHERE id=?').get(id);
  db.prepare('DELETE FROM drivers WHERE id = ?').run(id);
  audit(ctx, 'driver', id, 'delete', `Deleted driver ${d?.name}`);
}

// ============================== TRIPS ============================== //
function isDriverAssignable(d) {
  if (d.status === 'On Trip')   return [false, 'Driver is On Trip.'];
  if (d.status === 'Suspended') return [false, 'Driver is Suspended.'];
  if (new Date(d.license_expiry) < new Date()) return [false, 'Driver license has expired.'];
  return [true, ''];
}
function isVehicleAssignable(v) {
  if (v.status === 'On Trip')  return [false, 'Vehicle is On Trip.'];
  if (v.status === 'In Shop')  return [false, 'Vehicle is In Shop.'];
  if (v.status === 'Retired')  return [false, 'Vehicle is Retired.'];
  return [true, ''];
}

function listTrips(filters = {}) {
  let q = `SELECT t.*, v.reg_no AS vehicle_reg, v.name AS vehicle_name,
                  d.name AS driver_name
           FROM trips t
           JOIN vehicles v ON v.id = t.vehicle_id
           JOIN drivers d ON d.id = t.driver_id
           WHERE 1=1`;
  const args = [];
  if (filters.status && filters.status !== 'All') { q += ' AND t.status = ?'; args.push(filters.status); }
  q += ' ORDER BY t.id DESC';
  return db.prepare(q).all(...args);
}
function getTrip(id) {
  return db.prepare(
    `SELECT t.*, v.reg_no AS vehicle_reg, v.name AS vehicle_name, d.name AS driver_name
     FROM trips t
     JOIN vehicles v ON v.id = t.vehicle_id
     JOIN drivers d ON d.id = t.driver_id
     WHERE t.id = ?`
  ).get(id);
}
function createTrip(ctx, { source, destination, vehicle_id, driver_id, cargo_kg, planned_distance_km }) {
  const v = getVehicle(vehicle_id);
  const d = getDriver(driver_id);
  if (!v || !d) return [false, 'Vehicle or driver not found.'];
  const [vok, vmsg] = isVehicleAssignable(v); if (!vok) return [false, vmsg];
  const [dok, dmsg] = isDriverAssignable(d); if (!dok) return [false, dmsg];
  if (+cargo_kg > +v.max_load_kg)
    return [false, `Cargo weight ${cargo_kg} kg exceeds vehicle's max load ${v.max_load_kg} kg.`];
  const r = db.prepare(
    `INSERT INTO trips
     (source,destination,vehicle_id,driver_id,cargo_kg,planned_distance_km,status,created_at)
     VALUES (?,?,?,?,?,?, 'Draft', ?)`
  ).run(source.trim(), destination.trim(), vehicle_id, driver_id,
        +cargo_kg, +planned_distance_km, now());
  audit(ctx, 'trip', r.lastInsertRowid, 'create',
        `Trip ${source}→${destination} (${cargo_kg}kg) created`);
  return [true, 'Trip created (Draft).'];
}
function dispatchTrip(ctx, id) {
  const t = getTrip(id);
  if (!t || t.status !== 'Draft') return [false, 'Only Draft trips can be dispatched.'];
  const v = getVehicle(t.vehicle_id);
  const d = getDriver(t.driver_id);
  const [vok, vmsg] = isVehicleAssignable(v); if (!vok) return [false, vmsg];
  const [dok, dmsg] = isDriverAssignable(d); if (!dok) return [false, dmsg];
  if (t.cargo_kg > v.max_load_kg) return [false, 'Cargo weight exceeds vehicle max load.'];

  const tx = db.transaction(() => {
    db.prepare(`UPDATE trips SET status='Dispatched', dispatched_at=?, start_odometer=? WHERE id=?`)
      .run(now(), v.odometer_km, id);
    db.prepare(`UPDATE vehicles SET status='On Trip' WHERE id=?`).run(t.vehicle_id);
    db.prepare(`UPDATE drivers  SET status='On Trip' WHERE id=?`).run(t.driver_id);
  });
  tx();
  audit(ctx, 'trip', id, 'dispatch', `Dispatched trip ${v.reg_no} → driver ${d.name}`);
  return [true, 'Trip dispatched. Vehicle & driver are now On Trip.'];
}
function completeTrip(ctx, id, { end_odometer, fuel_used_liters, revenue }) {
  const t = getTrip(id);
  if (!t || t.status !== 'Dispatched') return [false, 'Only Dispatched trips can be completed.'];
  if (+end_odometer < (t.start_odometer || 0))
    return [false, 'End odometer must be >= start odometer.'];

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE trips SET status='Completed', completed_at=?, end_odometer=?,
       fuel_used_liters=?, revenue=? WHERE id=?`
    ).run(now(), +end_odometer, +fuel_used_liters, +revenue, id);
    db.prepare(`UPDATE vehicles SET odometer_km=?, status='Available' WHERE id=?`)
      .run(+end_odometer, t.vehicle_id);
    db.prepare(`UPDATE drivers  SET status='Available' WHERE id=?`).run(t.driver_id);
    if (+fuel_used_liters > 0) {
      db.prepare(
        `INSERT INTO fuel_logs
         (vehicle_id,trip_id,liters,cost,log_date,odometer_km,created_at)
         VALUES (?,?,?,?,?,?,?)`
      ).run(t.vehicle_id, id, +fuel_used_liters, 0,
            new Date().toISOString().slice(0, 10), +end_odometer, now());
    }
  });
  tx();
  audit(ctx, 'trip', id, 'complete', `Completed trip — odometer ${end_odometer}, fuel ${fuel_used_liters}L, revenue ₹${revenue}`);
  return [true, 'Trip completed. Vehicle & driver are now Available.'];
}
function cancelTrip(ctx, id) {
  const t = getTrip(id);
  if (!t) return [false, 'Trip not found.'];
  if (t.status === 'Completed') return [false, 'Completed trips cannot be cancelled.'];
  if (t.status === 'Cancelled') return [false, 'Trip is already cancelled.'];

  const tx = db.transaction(() => {
    db.prepare(`UPDATE trips SET status='Cancelled' WHERE id=?`).run(id);
    if (t.status === 'Dispatched') {
      const v = getVehicle(t.vehicle_id);
      const d = getDriver(t.driver_id);
      if (v && v.status === 'On Trip') db.prepare(`UPDATE vehicles SET status='Available' WHERE id=?`).run(t.vehicle_id);
      if (d && d.status === 'On Trip') db.prepare(`UPDATE drivers  SET status='Available' WHERE id=?`).run(t.driver_id);
    }
  });
  tx();
  audit(ctx, 'trip', id, 'cancel', `Cancelled trip ${t.source}→${t.destination}`);
  return [true, 'Trip cancelled.'];
}

// ============================== MAINTENANCE ============================== //
function listMaintenance(vid = null) {
  let q = `SELECT m.*, v.reg_no AS vehicle_reg, v.name AS vehicle_name
           FROM maintenance m JOIN vehicles v ON v.id = m.vehicle_id WHERE 1=1`;
  const args = [];
  if (vid) { q += ' AND m.vehicle_id = ?'; args.push(vid); }
  q += ' ORDER BY m.id DESC';
  return db.prepare(q).all(...args);
}
function createMaintenance(ctx, { vehicle_id, description, cost, notes }) {
  const tx = db.transaction(() => {
    const r = db.prepare(
      `INSERT INTO maintenance
       (vehicle_id,description,cost,start_date,status,notes,created_at)
       VALUES (?,?,?,?,'Open',?,?)`
    ).run(vehicle_id, description.trim(), +cost,
          new Date().toISOString().slice(0, 10), notes || '', now());
    db.prepare(`UPDATE vehicles SET status='In Shop' WHERE id=?`).run(vehicle_id);
    return r.lastInsertRowid;
  });
  const mid = tx();
  const v = getVehicle(vehicle_id);
  audit(ctx, 'maintenance', mid, 'create',
        `${v?.reg_no}: ${description} (₹${cost})`);
  return [true, 'Maintenance record created. Vehicle moved to In Shop.'];
}
function closeMaintenance(ctx, mid) {
  const r = db.prepare('SELECT * FROM maintenance WHERE id = ?').get(mid);
  if (!r) return [false, 'Maintenance record not found.'];
  const tx = db.transaction(() => {
    db.prepare(`UPDATE maintenance SET status='Closed', end_date=? WHERE id=?`)
      .run(new Date().toISOString().slice(0, 10), mid);
    const v = getVehicle(r.vehicle_id);
    if (v && v.status === 'In Shop')
      db.prepare(`UPDATE vehicles SET status='Available' WHERE id=?`).run(r.vehicle_id);
  });
  tx();
  audit(ctx, 'maintenance', mid, 'close', `Closed maintenance #${mid}`);
  return [true, 'Maintenance closed. Vehicle restored to Available.'];
}
function deleteMaintenance(ctx, mid) {
  db.prepare('DELETE FROM maintenance WHERE id = ?').run(mid);
  audit(ctx, 'maintenance', mid, 'delete', `Deleted maintenance #${mid}`);
}

// ============================== FUEL & EXPENSES ============================== //
function listFuel(vid = null) {
  let q = `SELECT f.*, v.reg_no AS vehicle_reg
           FROM fuel_logs f JOIN vehicles v ON v.id = f.vehicle_id WHERE 1=1`;
  const args = [];
  if (vid) { q += ' AND f.vehicle_id = ?'; args.push(vid); }
  q += ' ORDER BY f.id DESC';
  return db.prepare(q).all(...args);
}
function addFuel(ctx, { vehicle_id, liters, cost, log_date, odometer_km, trip_id = null }) {
  const r = db.prepare(
    `INSERT INTO fuel_logs
     (vehicle_id,trip_id,liters,cost,log_date,odometer_km,created_at)
     VALUES (?,?,?,?,?,?,?)`
  ).run(vehicle_id, trip_id, +liters, +cost, log_date, +odometer_km || null, now());
  audit(ctx, 'fuel', r.lastInsertRowid, 'create',
        `Fuel log: ${liters}L, ₹${cost}`);
}
function listExpenses(vid = null) {
  let q = `SELECT e.*, v.reg_no AS vehicle_reg
           FROM expenses e LEFT JOIN vehicles v ON v.id = e.vehicle_id WHERE 1=1`;
  const args = [];
  if (vid) { q += ' AND e.vehicle_id = ?'; args.push(vid); }
  q += ' ORDER BY e.id DESC';
  return db.prepare(q).all(...args);
}
function addExpense(ctx, { vehicle_id, category, description, amount, expense_date }) {
  const r = db.prepare(
    `INSERT INTO expenses
     (vehicle_id,category,description,amount,expense_date,created_at)
     VALUES (?,?,?,?,?,?)`
  ).run(vehicle_id || null, category, description || '', +amount, expense_date, now());
  audit(ctx, 'expense', r.lastInsertRowid, 'create',
        `${category}: ₹${amount}`);
}

// ============================== ANALYTICS ============================== //
function dashboardKpis() {
  const get = (sql) => db.prepare(sql).get().c;
  const total = get('SELECT COUNT(*) c FROM vehicles');
  const activeV = get(`SELECT COUNT(*) c FROM vehicles WHERE status='On Trip'`);
  const availableV = get(`SELECT COUNT(*) c FROM vehicles WHERE status='Available'`);
  const inShop = get(`SELECT COUNT(*) c FROM vehicles WHERE status='In Shop'`);
  const activeT = get(`SELECT COUNT(*) c FROM trips WHERE status='Dispatched'`);
  const pendingT = get(`SELECT COUNT(*) c FROM trips WHERE status='Draft'`);
  const onDuty = get(`SELECT COUNT(*) c FROM drivers WHERE status='On Trip'`);
  return {
    active_vehicles: activeV,
    available_vehicles: availableV,
    in_shop: inShop,
    active_trips: activeT,
    pending_trips: pendingT,
    drivers_on_duty: onDuty,
    fleet_utilization: total ? +((activeV / total) * 100).toFixed(1) : 0,
    total_vehicles: total,
  };
}

function vehicleMetrics() {
  const vehicles = db.prepare('SELECT * FROM vehicles').all();
  return vehicles.map((v) => {
    const fuel = db.prepare('SELECT COALESCE(SUM(cost),0) c FROM fuel_logs WHERE vehicle_id=?').get(v.id).c;
    const maint = db.prepare('SELECT COALESCE(SUM(cost),0) c FROM maintenance WHERE vehicle_id=?').get(v.id).c;
    const misc = db.prepare('SELECT COALESCE(SUM(amount),0) c FROM expenses WHERE vehicle_id=?').get(v.id).c;
    const distance = db.prepare(
      `SELECT COALESCE(SUM(end_odometer-start_odometer),0) d
       FROM trips WHERE vehicle_id=? AND status='Completed'`
    ).get(v.id).d;
    const fuel_liters = db.prepare('SELECT COALESCE(SUM(liters),0) l FROM fuel_logs WHERE vehicle_id=?').get(v.id).l;
    const revenue = db.prepare(
      `SELECT COALESCE(SUM(revenue),0) r FROM trips WHERE vehicle_id=? AND status='Completed'`
    ).get(v.id).r;
    const opCost = fuel + maint + misc;
    const eff = fuel_liters ? distance / fuel_liters : 0;
    const roi = v.acquisition_cost > 0
      ? ((revenue - (maint + fuel)) / v.acquisition_cost) * 100
      : 0;
    return {
      id: v.id, reg_no: v.reg_no, name: v.name, type: v.type, status: v.status,
      acquisition_cost: v.acquisition_cost, distance_km: distance,
      fuel_liters, fuel_efficiency: +eff.toFixed(2),
      fuel_cost: fuel, maintenance_cost: maint, misc_cost: misc,
      operational_cost: opCost, revenue, roi_pct: +roi.toFixed(2),
    };
  });
}

function listNotifications() {
  return db.prepare('SELECT * FROM notifications ORDER BY id DESC').all();
}
function markAllNotificationsRead() {
  db.prepare('UPDATE notifications SET read = 1').run();
}

function listAudit(limit = 100) {
  return db.prepare(
    'SELECT * FROM audit_log ORDER BY id DESC LIMIT ?'
  ).all(limit);
}

// ============================== PREDICTIVE MAINTENANCE ============================== //
function predictiveMaintenance() {
  const metrics = vehicleMetrics();
  const out = [];
  for (const m of metrics) {
    const v = getVehicle(m.id);
    const daysSinceMaint = db.prepare(
      `SELECT julianday('now') - julianday(MAX(start_date)) d
       FROM maintenance WHERE vehicle_id=?`
    ).get(v.id).d || 999;
    const maintCount = db.prepare(
      'SELECT COUNT(*) c FROM maintenance WHERE vehicle_id=?'
    ).get(v.id).c;

    // Score: higher = more likely to need service
    let score = 0;
    const reasons = [];

    // age factor
    if (m.distance_km > 50000) { score += 30; reasons.push('High odometer (>50k km)'); }
    else if (m.distance_km > 25000) { score += 15; reasons.push('Moderate odometer'); }

    // fuel-efficiency drift (low efficiency = engine wear)
    if (m.fuel_liters > 0 && m.fuel_efficiency < 6) {
      score += 25; reasons.push('Poor fuel efficiency (<6 km/L)');
    }

    // days since last maintenance
    if (daysSinceMaint > 180) { score += 25; reasons.push('No maintenance in 180+ days'); }
    else if (daysSinceMaint > 90) { score += 10; reasons.push('No maintenance in 90+ days'); }

    // frequent repairs
    if (maintCount >= 3) { score += 15; reasons.push(`${maintCount} prior repairs`); }

    // low ROI = under-utilized but still costing
    if (m.roi_pct < 5) { score += 5; reasons.push('Low utilization'); }

    let risk = 'Low';
    if (score >= 60) risk = 'High';
    else if (score >= 30) risk = 'Medium';

    out.push({
      vehicle_id: v.id,
      reg_no: v.reg_no,
      name: v.name,
      type: v.type,
      status: v.status,
      distance_km: m.distance_km,
      days_since_maint: Math.min(daysSinceMaint, 9999),
      maint_count: maintCount,
      risk_score: score,
      risk,
      reasons,
    });
  }
  return out.sort((a, b) => b.risk_score - a.risk_score);
}

// ============================== DRIVER LEADERBOARD ============================== //
function driverLeaderboard() {
  const drivers = db.prepare('SELECT * FROM drivers').all();
  return drivers.map((d) => {
    const trips = db.prepare(
      "SELECT COUNT(*) c FROM trips WHERE driver_id=? AND status='Completed'"
    ).get(d.id).c;
    const distance = db.prepare(
      `SELECT COALESCE(SUM(end_odometer-start_odometer),0) d
       FROM trips WHERE driver_id=? AND status='Completed'`
    ).get(d.id).d;
    // badge by safety score
    let badge = '🥉';
    if (d.safety_score >= 90) badge = '🥇';
    else if (d.safety_score >= 80) badge = '🥈';
    return {
      id: d.id, name: d.name, license_no: d.license_no,
      status: d.status, safety_score: d.safety_score,
      trips_completed: trips, distance_km: distance, badge,
    };
  }).sort((a, b) => b.safety_score - a.safety_score);
}

// ============================== AI ASSISTANT — real conversational engine ============================== //
// Three layers:
//   1) Greeting/identity questions -> friendly canned answers
//   2) Domain-specific data questions -> data-backed answers from SQLite
//   3) Free-form questions -> general conversational responder
// Context-aware: last 4 messages remembered for follow-ups.
const aiContext = [];
const AI_CTX_LIMIT = 4;
function aiRecord(q, a) {
  aiContext.push({ q, a, ts: Date.now() });
  while (aiContext.length > AI_CTX_LIMIT) aiContext.shift();
}
function aiFleetSnapshot() {
  return {
    metrics: vehicleMetrics(),
    trips: db.prepare('SELECT * FROM trips').all(),
    drivers: db.prepare('SELECT * FROM drivers').all(),
    vehicles: db.prepare('SELECT * FROM vehicles').all(),
    kpis: dashboardKpis(),
  };
}
function aiMostExpensive() {
  const { metrics } = aiFleetSnapshot();
  const top = [...metrics].sort((a, b) => b.operational_cost - a.operational_cost).slice(0, 3);
  return {
    answer: 'Top 3 vehicles by operational cost:',
    table: top.map(m => ({
      'Registration': m.reg_no, 'Name': m.name,
      'Op. Cost': 'Rs ' + m.operational_cost.toLocaleString('en-IN'),
      'Fuel': 'Rs ' + m.fuel_cost.toLocaleString('en-IN'),
      'Maint.': 'Rs ' + m.maintenance_cost.toLocaleString('en-IN'),
    })),
  };
}
function aiBestROI() {
  const { metrics } = aiFleetSnapshot();
  const top = [...metrics].filter(m => m.revenue > 0)
    .sort((a, b) => b.roi_pct - a.roi_pct).slice(0, 3);
  if (!top.length) return { answer: 'No vehicles have generated revenue yet. Complete some trips first.' };
  return {
    answer: 'Top vehicles by ROI:',
    table: top.map(m => ({
      'Registration': m.reg_no, 'Name': m.name,
      'Revenue': 'Rs ' + m.revenue.toLocaleString('en-IN'),
      'ROI': m.roi_pct.toFixed(1) + '%',
    })),
  };
}
function aiWorstFuelEff() {
  const { metrics } = aiFleetSnapshot();
  const eff = metrics.filter(m => m.fuel_liters > 0)
    .sort((a, b) => a.fuel_efficiency - b.fuel_efficiency).slice(0, 3);
  return {
    answer: 'Vehicles with the lowest fuel efficiency (km/L):',
    table: eff.map(m => ({
      'Registration': m.reg_no, 'Name': m.name,
      'Distance (km)': m.distance_km, 'Fuel (L)': m.fuel_liters,
      'Efficiency': m.fuel_efficiency.toFixed(2) + ' km/L',
    })),
  };
}
function aiExpiredLicenses() {
  const { drivers } = aiFleetSnapshot();
  const today = new Date();
  const exp = drivers.filter(d => new Date(d.license_expiry) < today);
  return {
    answer: exp.length + ' driver(s) have EXPIRED licenses:',
    table: exp.map(d => ({ Name: d.name, License: d.license_no, 'Expired On': d.license_expiry })),
  };
}
function aiExpiringSoon() {
  const { drivers } = aiFleetSnapshot();
  const today = new Date();
  const in60 = drivers.filter(d => {
    const diff = (new Date(d.license_expiry) - today) / (1000 * 3600 * 24);
    return diff >= 0 && diff <= 60;
  }).map(d => {
    const days = Math.floor((new Date(d.license_expiry) - today) / (1000 * 3600 * 24));
    return Object.assign({}, d, { _days: days });
  }).sort((a, b) => a._days - b._days);
  return {
    answer: in60.length + ' driver(s) have licenses expiring within 60 days:',
    table: in60.map(d => ({ Name: d.name, License: d.license_no, 'Expires On': d.license_expiry, 'Days Left': d._days })),
  };
}
function aiAvailable() {
  const { vehicles } = aiFleetSnapshot();
  const v = vehicles.filter(x => x.status === 'Available');
  return {
    answer: v.length + ' vehicle(s) are currently Available:',
    table: v.map(x => ({ Registration: x.reg_no, Name: x.name, Type: x.type, Region: x.region })),
  };
}
function aiActiveTrips() {
  const { trips, vehicles } = aiFleetSnapshot();
  const t = trips.filter(x => x.status === 'Dispatched');
  return {
    answer: t.length + ' trip(s) are currently Dispatched / active:',
    table: t.map(x => ({
      '#': x.id, Source: x.source, Destination: x.destination,
      Vehicle: (vehicles.find(v => v.id === x.vehicle_id) || {}).reg_no || ('id=' + x.vehicle_id),
      'Cargo (kg)': x.cargo_kg,
    })),
  };
}
function aiInShop() {
  const { vehicles } = aiFleetSnapshot();
  const v = vehicles.filter(x => x.status === 'In Shop');
  return {
    answer: v.length + ' vehicle(s) are currently In Shop:',
    table: v.map(x => ({ Registration: x.reg_no, Name: x.name, Region: x.region })),
  };
}
function aiUtilization() {
  const { kpis } = aiFleetSnapshot();
  return {
    answer: 'Fleet utilization is ' + kpis.fleet_utilization + '% (' +
            kpis.active_vehicles + ' of ' + kpis.total_vehicles +
            ' vehicles active). Drivers on duty: ' + kpis.drivers_on_duty + '.',
  };
}
function aiTotalRevenue() {
  const { metrics } = aiFleetSnapshot();
  const total = metrics.reduce((s, m) => s + m.revenue, 0);
  return { answer: 'Total revenue across all vehicles: Rs ' + total.toLocaleString('en-IN') + '.' };
}
function aiTotalCost() {
  const { metrics } = aiFleetSnapshot();
  const total = metrics.reduce((s, m) => s + m.operational_cost, 0);
  return { answer: 'Total operational cost: Rs ' + total.toLocaleString('en-IN') + '.' };
}
function aiSummary() {
  const { kpis } = aiFleetSnapshot();
  return {
    answer:
      'Fleet: ' + kpis.total_vehicles + ' total, ' + kpis.active_vehicles + ' on trip, ' +
      kpis.available_vehicles + ' available, ' + kpis.in_shop + ' in shop. ' +
      'Trips: ' + kpis.active_trips + ' dispatched, ' + kpis.pending_trips + ' pending. ' +
      'Drivers on duty: ' + kpis.drivers_on_duty + '. Utilization: ' + kpis.fleet_utilization + '%.',
  };
}
function aiVehicleDetail(q) {
  const { vehicles, metrics } = aiFleetSnapshot();
  const m = q.match(/\b(vls[-\s]?\d+|[a-z]{2,3}[-\s]?\d{2,4})\b/i);
  if (!m) return null;
  const reg = m[1].toUpperCase().replace(/\s+/g, '-');
  const v = vehicles.find(x => x.reg_no.toUpperCase() === reg);
  if (!v) return { answer: 'I could not find a vehicle with registration ' + reg + '. Use the search bar (Ctrl+K) to look it up.' };
  const met = metrics.find(x => x.reg_no === v.reg_no) || {};
  let extra = '';
  if (met.distance_km !== undefined) {
    extra = ' Driven ' + (met.distance_km||0).toLocaleString('en-IN') + ' km, ROI ' +
            (met.roi_pct||0).toFixed(1) + '%, revenue Rs ' + (met.revenue||0).toLocaleString('en-IN') + '.';
  }
  return {
    answer: v.reg_no + ' - ' + v.name + ' (' + v.type + ', ' + v.region +
            ', status: ' + v.status + ', max load: ' + v.max_load_kg + ' kg, ' +
            'odometer: ' + (v.odometer_km||0).toLocaleString('en-IN') + ' km).' + extra,
  };
}
function aiFollowupAnswer(q) {
  const last = aiContext[aiContext.length - 1];
  if (!last) return null;
  if (/^(what about|how about|and|also|now|then)\b/i.test(q)) {
    return aiAsk(last.q + '. ' + q, 1);
  }
  return null;
}
function aiGeneralAnswer(q) {
  const s = q.toLowerCase().trim();
  if (/^(hi|hello|hey|yo|howdy|good (morning|afternoon|evening))\b/.test(s))
    return { answer: "Hi! I'm Vaelos AI - your operations copilot. Ask me anything about your fleet, drivers, trips, costs, or any general topic." };
  if (/who are you|what are you|your name|who made you/.test(s))
    return { answer: "I'm Vaelos AI - a conversational assistant built into the Vaelos transport-operations platform. I can query your live fleet data and also chat about anything you want." };
  if (/help|what can you do|capabilities|commands/.test(s))
    return {
      answer: 'I can help with both data and conversation:',
      table: [
        { Topic: 'Fleet data',  Example: '"which vehicles are available?", "show me VLS-05", "best ROI"' },
        { Topic: 'Drivers',     Example: '"expired licenses", "expiring soon", "driver safety score"' },
        { Topic: 'Trips',       Example: '"active trips", "completed trips", "cargo summary"' },
        { Topic: 'Finance',     Example: '"total revenue", "total cost", "fuel efficiency"' },
        { Topic: 'Maintenance', Example: '"in-shop vehicles", "predictive risks"' },
        { Topic: 'General',     Example: '"what is km/L efficiency?", "how do I cut fuel costs?", "explain ROI"' },
      ],
    };
  if (/what is (km\/l|km per liter|fuel efficiency)/.test(s))
    return { answer: 'Fuel efficiency = kilometers driven per liter of fuel. Higher is better. It is computed as distance_km divided by fuel_liters from completed trips. Typical ranges: small cars 14-18 km/L, vans 10-14, trucks 4-7, buses 3-5.' };
  if (/what is roi|return on investment/.test(s))
    return { answer: 'ROI here = (revenue - operational cost) divided by acquisition cost, expressed as a percentage. A higher ROI means the vehicle is earning more than it costs relative to what you paid for it.' };
  if (/what is fleet utili[sz]ation/.test(s))
    return { answer: 'Fleet utilization = active vehicles divided by total fleet, expressed as a percentage. A higher number means more of your vehicles are out earning. Healthy targets depend on industry, but 60-80% is typical for delivery fleets.' };
  if (/what is predictive maintenance/.test(s))
    return { answer: 'Predictive maintenance flags vehicles that are likely to fail soon, based on odometer, days since last service, repair history, and fuel-economy drift. We surface High / Medium / Low risk vehicles in the Predictive AI page.' };
  if (/how (do|can) i (cut|reduce) fuel/.test(s))
    return { answer: 'Common ways: (1) driver training - gentle acceleration and steady speeds cut fuel use 5-15%, (2) tyre pressure checks weekly, (3) route optimisation to avoid idling, (4) preventive maintenance so engines run at spec, (5) idle-time limits via telematics.' };
  if (/best practices for driver safety|how to improve safety score/.test(s))
    return { answer: 'Safety scores improve with: no harsh braking/acceleration, adherence to speed limits, completing trips without incidents, license compliance, and timely rest breaks. Our leaderboard ranks drivers on these signals.' };
  if (/dispatch|how does dispatch work/.test(s))
    return { answer: 'A trip is created in Draft, then Dispatched. Dispatch validates that cargo is less than or equal to the vehicle max load, the driver license is not expired, and the driver or vehicle is not already on a trip. On completion, odometer and fuel are recorded and ROI is recomputed.' };
  if (/should i (buy|purchase|invest in) a (truck|van|bus|car)/.test(s))
    return { answer: 'It depends on your route profile. Vans are best for urban last-mile (high utilization, low fuel cost). Trucks shine on long-haul freight (high revenue per km, but lower utilization). Buses fit scheduled routes with high passenger counts. Cars are economical for supervisory runs. I can compare your actual ROI per vehicle type - just ask "show ROI by type".' };
  if (/recommend|suggest|advice/.test(s))
    return { answer: 'I am happy to recommend things - but recommendations are better when grounded in your data. Try asking "which vehicle should I retire?", "which driver should I promote to safety officer?", or "which region has the worst utilization?".' };
  if (/what (time|date|day) is it|what's today/.test(s))
    return { answer: "It's " + new Date().toLocaleString() + ". Want to know anything about today's trips or vehicles?" };
  if (/^(thanks|thank you|thx|ty)\b/.test(s))
    return { answer: "You're welcome - happy to help whenever you need it." };
  return {
    answer:
      "I don't have a specific data point for that, but I can still help. Ask me anything - fleet ops, drivers, trips, costs, transport terms, recommendations, or just chat. " +
      'Try "help" to see what I am good at.',
  };
}
function aiAsk(question, _depth) {
  const q = String(question || '').trim();
  if (!q) return { answer: 'Please ask a question.' };
  const depth = _depth || 0;
  if (depth === 0) {
    const follow = aiFollowupAnswer(q);
    if (follow) { aiRecord(q, follow.answer); return follow; }
  }
  const low = q.toLowerCase();
  // Pure math / pure clock -> handle before any data lookup so we never
  // accidentally match a stray number as a vehicle registration.
  const math = q.match(/^(?:what(?:'s| is)?\s+)?(\d+(?:\.\d+)?)\s*([+\-*/x×÷])\s*(\d+(?:\.\d+)?)\s*\??$/i);
  if (math) {
    const a = +math[1], op = math[2], b = +math[3];
    let r;
    if (op === '+') r = a + b;
    else if (op === '-') r = a - b;
    else if (op === '*' || op === 'x' || op === '×') r = a * b;
    else if (op === '/' || op === '÷') r = b === 0 ? 'infinity' : a / b;
    const ans = a + ' ' + op + ' ' + b + ' = ' + (typeof r === 'number' ? r.toLocaleString('en-IN') : r);
    aiRecord(q, ans);
    return { answer: ans };
  }
  const checks = [
    [/most expensive|highest cost|biggest cost|costliest/,        aiMostExpensive],
    [/best roi|highest roi|most profitable|top earner/,           aiBestROI],
    [/lowest fuel|worst fuel|bad efficiency|low efficiency|fuel.{0,5}efficien/, aiWorstFuelEff],
    [/expired license|license.{0,10}expir/,                       aiExpiredLicenses],
    [/expiring|about to expire|expir(es|y) soon/,                 aiExpiringSoon],
    [/available vehicle|free vehicle|which vehicle|ready to assign/, aiAvailable],
    [/on trip|active trip|dispatched|currently running/,          aiActiveTrips],
    [/in shop|under repair|being serviced|in maintenance/,        aiInShop],
    [/utili[sz]ation|utili[sz]ation rate/,                        aiUtilization],
    [/total revenue|revenue total|how much revenue/,              aiTotalRevenue],
    [/total cost|operational cost total|spend total/,             aiTotalCost],
    [/^summary$|overview|^kpis?$|give me a summary/,               aiSummary],
    [/drivers? on duty|drivers? (who|active)/,                    aiUtilization],
  ];
  for (let i = 0; i < checks.length; i++) {
    if (checks[i][0].test(low)) {
      const out = checks[i][1]();
      aiRecord(q, out.answer);
      return out;
    }
  }
  const v = aiVehicleDetail(low);
  if (v) { aiRecord(q, v.answer); return v; }
  const g = aiGeneralAnswer(q);
  aiRecord(q, g.answer);
  return g;
}

module.exports = {
  // users
  listUsers, addUser, deleteUser,
  // vehicles
  listVehicles, getVehicle, addVehicle, updateVehicle, deleteVehicle,
  // drivers
  listDrivers, getDriver, addDriver, updateDriver, deleteDriver,
  // trips
  listTrips, getTrip, createTrip, dispatchTrip, completeTrip, cancelTrip,
  isDriverAssignable, isVehicleAssignable,
  // maintenance
  listMaintenance, createMaintenance, closeMaintenance, deleteMaintenance,
  // fuel/expenses
  listFuel, addFuel, listExpenses, addExpense,
  // analytics
  dashboardKpis, vehicleMetrics, listNotifications, markAllNotificationsRead,
  listAudit, predictiveMaintenance, driverLeaderboard, aiAsk,
};
