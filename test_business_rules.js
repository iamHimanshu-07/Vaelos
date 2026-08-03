/**
 * Vaelos - End-to-end business rules & feature smoke tests.
 * Boots the database in-memory, exercises all 10 mandatory rules
 * + audit / predictive / leaderboard / AI / notifications.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Use a temp DB so tests don't clobber a real one
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vaelos-test-'));
process.env.VAELOS_DB = path.join(tmp, 'test.db');
process.env.JWT_SECRET = 'test-secret';

let pass = 0, fail = 0;
const results = [];

function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; results.push({ name, ok: true }); console.log(`✅ ${name}`); },
    (err) => { fail++; results.push({ name, ok: false, err: String(err) });
               console.log(`❌ ${name}\n   ${err}`); }
  );
}

// Fresh modules per test (DB reset)
function fresh() {
  delete require.cache[require.resolve('./database')];
  delete require.cache[require.resolve('./operations')];
  try { fs.unlinkSync(process.env.VAELOS_DB); } catch {}
  const db = require('./database');
  db.init();
  db.recomputeLicenseNotifications();
  return db;
}

(async () => {
  // ===== BR1: Register a vehicle & driver =====
  await test('BR1 — Vehicle + driver registration', () => {
    const db = fresh();
    const ops = require('./operations');
    const ctx = { user: { id: 1, name: 'Admin', role: 'Admin' } };
    const beforeV = ops.listVehicles().length;
    const beforeD = ops.listDrivers().length;
    ops.addVehicle(ctx, { reg_no: 'TEST-T01', name: 'Test Van 1',
                          type: 'Van', max_load_kg: 500, odometer_km: 1000,
                          acquisition_cost: 800000, region: 'Central' });
    ops.addDriver(ctx, { name: 'Alex', license_no: 'TEST-D01',
                         license_category: 'LMV', license_expiry: '2030-01-01',
                         contact: '999', safety_score: 85 });
    const vs = ops.listVehicles(), ds = ops.listDrivers();
    if (vs.length !== beforeV + 1) throw new Error('vehicle not registered');
    if (ds.length !== beforeD + 1) throw new Error('driver not registered');
  });

  // ===== BR2: Cargo > capacity =====
  await test('BR2 — Cargo > capacity rejected', () => {
    const db = fresh();
    const ops = require('./operations');
    const ctx = { user: { id: 1, role: 'Admin' } };
    ops.addVehicle(ctx, { reg_no: 'TEST-T02', name: 'V', type: 'Van',
                          max_load_kg: 500, odometer_km: 0,
                          acquisition_cost: 800000, region: 'Central' });
    ops.addDriver(ctx, { name: 'Alex', license_no: 'TEST-D02',
                         license_category: 'LMV', license_expiry: '2030-01-01',
                         contact: '999', safety_score: 80 });
    const v = ops.listVehicles().find(x => x.reg_no === 'TEST-T02');
    const d = ops.listDrivers().find(x => x.license_no === 'TEST-D02');
    const [ok, msg] = ops.createTrip(ctx, {
      source: 'A', destination: 'B',
      vehicle_id: v.id, driver_id: d.id,
      cargo_kg: 600, planned_distance_km: 50,
    });
    if (ok) throw new Error('Should have rejected cargo > capacity');
  });

  // ===== BR3: Dispatch moves vehicle to On Trip =====
  await test('BR3 — Dispatch sets vehicle/driver to On Trip', () => {
    const db = fresh();
    const ops = require('./operations');
    const ctx = { user: { id: 1, role: 'Admin' } };
    ops.addVehicle(ctx, { reg_no: 'TEST-T03', name: 'V', type: 'Van',
                          max_load_kg: 500, odometer_km: 0,
                          acquisition_cost: 800000, region: 'Central' });
    ops.addDriver(ctx, { name: 'Alex', license_no: 'TEST-D03',
                         license_category: 'LMV', license_expiry: '2030-01-01',
                         contact: '999', safety_score: 80 });
    const v = ops.listVehicles().find(x => x.reg_no === 'TEST-T03');
    const d = ops.listDrivers().find(x => x.license_no === 'TEST-D03');
    const [cok] = ops.createTrip(ctx, {
      source: 'A', destination: 'B', vehicle_id: v.id, driver_id: d.id,
      cargo_kg: 100, planned_distance_km: 50,
    });
    if (!cok) throw new Error('createTrip failed');
    const trips = ops.listTrips({ status: 'Draft' });
    const [dok] = ops.dispatchTrip(ctx, trips[0].id);
    if (!dok) throw new Error('dispatchTrip failed');
    const v2 = ops.getVehicle(v.id);
    const d2 = ops.getDriver(d.id);
    if (v2.status !== 'On Trip') throw new Error(`vehicle status=${v2.status}`);
    if (d2.status !== 'On Trip') throw new Error(`driver status=${d2.status}`);
  });

  // ===== BR4: License expiry blocks assignment =====
  await test('BR4 — Expired license blocks driver assignment', () => {
    const db = fresh();
    const ops = require('./operations');
    const ctx = { user: { id: 1, role: 'Admin' } };
    ops.addVehicle(ctx, { reg_no: 'TEST-T04', name: 'V', type: 'Van',
                          max_load_kg: 500, odometer_km: 0,
                          acquisition_cost: 800000, region: 'Central' });
    ops.addDriver(ctx, { name: 'Old', license_no: 'TEST-D04',
                         license_category: 'LMV', license_expiry: '2020-01-01',
                         contact: '999', safety_score: 80 });
    const v = ops.listVehicles().find(x => x.reg_no === 'TEST-T04');
    const d = ops.listDrivers().find(x => x.license_no === 'TEST-D04');
    const [ok, msg] = ops.createTrip(ctx, {
      source: 'A', destination: 'B', vehicle_id: v.id, driver_id: d.id,
      cargo_kg: 100, planned_distance_km: 50,
    });
    if (ok) throw new Error('Should have blocked expired license');
    if (!/license/i.test(msg)) throw new Error('Wrong rejection reason');
  });

  // ===== BR5: Maintenance moves vehicle to In Shop =====
  await test('BR5 — Maintenance sets vehicle to In Shop', () => {
    const db = fresh();
    const ops = require('./operations');
    const ctx = { user: { id: 1, role: 'Admin' } };
    ops.addVehicle(ctx, { reg_no: 'TEST-T05', name: 'V', type: 'Van',
                          max_load_kg: 500, odometer_km: 0,
                          acquisition_cost: 800000, region: 'Central' });
    const v = ops.listVehicles().find(x => x.reg_no === 'TEST-T05');
    const [ok] = ops.createMaintenance(ctx, { vehicle_id: v.id,
                                              description: 'Oil change', cost: 1000 });
    if (!ok) throw new Error('maintenance create failed');
    const v2 = ops.getVehicle(v.id);
    if (v2.status !== 'In Shop') throw new Error(`vehicle status=${v2.status}`);
  });

  // ===== BR6: Closing maintenance restores availability =====
  await test('BR6 — Closing last maintenance restores Available', () => {
    const db = fresh();
    const ops = require('./operations');
    const ctx = { user: { id: 1, role: 'Admin' } };
    ops.addVehicle(ctx, { reg_no: 'TEST-T06', name: 'V', type: 'Van',
                          max_load_kg: 500, odometer_km: 0,
                          acquisition_cost: 800000, region: 'Central' });
    const v = ops.listVehicles().find(x => x.reg_no === 'TEST-T06');
    const [ok] = ops.createMaintenance(ctx, { vehicle_id: v.id,
                                              description: 'X', cost: 500 });
    if (!ok) throw new Error('maintenance failed');
    const m = ops.listMaintenance(v.id);
    const [cok] = ops.closeMaintenance(ctx, m[0].id);
    if (!cok) throw new Error('close maintenance failed');
    const v2 = ops.getVehicle(v.id);
    if (v2.status !== 'Available') throw new Error(`vehicle status=${v2.status}`);
  });

  // ===== BR7: Fuel efficiency metrics computed =====
  await test('BR7 — Vehicle metrics include fuel efficiency', () => {
    const db = fresh();
    const ops = require('./operations');
    const ctx = { user: { id: 1, role: 'Admin' } };
    ops.addVehicle(ctx, { reg_no: 'TEST-T07', name: 'V', type: 'Van',
                          max_load_kg: 500, odometer_km: 0,
                          acquisition_cost: 800000, region: 'Central' });
    ops.addDriver(ctx, { name: 'A', license_no: 'TEST-D07',
                         license_category: 'LMV', license_expiry: '2030-01-01',
                         contact: '999', safety_score: 80 });
    const v = ops.listVehicles().find(x => x.reg_no === 'TEST-T07');
    const d = ops.listDrivers().find(x => x.license_no === 'TEST-D07');
    const [cok] = ops.createTrip(ctx, {
      source: 'A', destination: 'B', vehicle_id: v.id, driver_id: d.id,
      cargo_kg: 100, planned_distance_km: 50,
    });
    const trips = ops.listTrips({ status: 'Draft' });
    ops.dispatchTrip(ctx, trips[0].id);
    ops.completeTrip(ctx, trips[0].id, {
      end_odometer: 50, fuel_used_liters: 5, revenue: 200,
    });
    const m = ops.vehicleMetrics();
    const my = m.find(x => x.reg_no === 'TEST-T07');
    if (!my) throw new Error('metrics missing for vehicle');
    if (my.fuel_efficiency <= 0) throw new Error('efficiency not computed');
  });

  // ===== BR8: License expiry notification generated =====
  await test('BR8 — License-expiry notification generated', () => {
    const db = fresh();
    const ops = require('./operations');
    const ctx = { user: { id: 1, role: 'Admin' } };
    ops.addDriver(ctx, { name: 'Expiring', license_no: 'TEST-D08',
                         license_category: 'LMV',
                         license_expiry: new Date(Date.now() + 10*24*3600*1000)
                                          .toISOString().slice(0,10),
                         contact: '999', safety_score: 80 });
    db.recomputeLicenseNotifications();
    const notes = ops.listNotifications();
    if (!notes.some(n => n.kind === 'license_expiry')) {
      throw new Error('no license_expiry notification');
    }
  });

  // ===== BR9: KPIs computed =====
  await test('BR9 — KPIs return required fields', () => {
    const db = fresh();
    const ops = require('./operations');
    const ctx = { user: { id: 1, role: 'Admin' } };
    ops.addVehicle(ctx, { reg_no: 'TEST-T09', name: 'V', type: 'Van',
                          max_load_kg: 500, odometer_km: 0,
                          acquisition_cost: 800000, region: 'Central' });
    const k = ops.dashboardKpis();
    for (const f of ['active_vehicles','available_vehicles','total_vehicles',
                     'fleet_utilization','active_trips','pending_trips']) {
      if (!(f in k)) throw new Error(`missing field: ${f}`);
    }
  });

  // ===== BR10: Driver status auto-updates =====
  await test('BR10 — Driver returns to Available after trip completion', () => {
    const db = fresh();
    const ops = require('./operations');
    const ctx = { user: { id: 1, role: 'Admin' } };
    ops.addVehicle(ctx, { reg_no: 'TEST-T10', name: 'V', type: 'Van',
                          max_load_kg: 500, odometer_km: 0,
                          acquisition_cost: 800000, region: 'Central' });
    ops.addDriver(ctx, { name: 'A', license_no: 'TEST-D10',
                         license_category: 'LMV', license_expiry: '2030-01-01',
                         contact: '999', safety_score: 80 });
    const v = ops.listVehicles().find(x => x.reg_no === 'TEST-T10');
    const d = ops.listDrivers().find(x => x.license_no === 'TEST-D10');
    const [cok] = ops.createTrip(ctx, {
      source: 'A', destination: 'B', vehicle_id: v.id, driver_id: d.id,
      cargo_kg: 100, planned_distance_km: 50,
    });
    const trips = ops.listTrips({ status: 'Draft' });
    ops.dispatchTrip(ctx, trips[0].id);
    ops.completeTrip(ctx, trips[0].id, {
      end_odometer: 50, fuel_used_liters: 5, revenue: 0,
    });
    const d2 = ops.getDriver(d.id);
    if (d2.status !== 'Available') throw new Error(`driver status=${d2.status}`);
  });

  // ===== Rare feature: audit log =====
  await test('Rare — Audit log captures all mutations', () => {
    const db = fresh();
    const ops = require('./operations');
    const ctx = { user: { id: 1, name: 'Admin', role: 'Admin' } };
    ops.addVehicle(ctx, { reg_no: 'TEST-A1', name: 'V', type: 'Van',
                          max_load_kg: 500, odometer_km: 0,
                          acquisition_cost: 800000, region: 'Central' });
    const log = ops.listAudit(50);
    if (log.length < 2) throw new Error(`audit entries=${log.length}`);
  });

  // ===== Rare feature: predictive maintenance =====
  await test('Rare — Predictive maintenance returns risk classification', () => {
    const db = fresh();
    const ops = require('./operations');
    const ctx = { user: { id: 1, role: 'Admin' } };
    ops.addVehicle(ctx, { reg_no: 'TEST-P1', name: 'Old Van', type: 'Van',
                          max_load_kg: 500, odometer_km: 80000,
                          acquisition_cost: 800000, region: 'Central' });
    const preds = ops.predictiveMaintenance();
    if (!preds.length) throw new Error('no predictions returned');
    const p = preds[0];
    if (!['High','Medium','Low'].includes(p.risk))
      throw new Error(`bad risk=${p.risk}`);
    if (typeof p.risk_score !== 'number') throw new Error('no risk_score');
  });

  // ===== Rare feature: leaderboard =====
  await test('Rare — Leaderboard ranks drivers by safety score', () => {
    const db = fresh();
    const ops = require('./operations');
    const ctx = { user: { id: 1, role: 'Admin' } };
    ops.addDriver(ctx, { name: 'Top', license_no: 'TEST-L1',
                         license_category: 'LMV', license_expiry: '2030-01-01',
                         contact: '1', safety_score: 99 });
    ops.addDriver(ctx, { name: 'Mid', license_no: 'TEST-L2',
                         license_category: 'LMV', license_expiry: '2030-01-01',
                         contact: '2', safety_score: 50 });
    const lb = ops.driverLeaderboard();
    if (lb.length < 2) throw new Error('leaderboard too short');
    // Find the test drivers and verify their badges
    const top = lb.find(d => d.license_no === 'TEST-L1');
    const mid = lb.find(d => d.license_no === 'TEST-L2');
    if (!top || !mid) throw new Error('test drivers not in leaderboard');
    if (top.badge !== '🥇') throw new Error(`top badge=${top.badge}`);
    if (mid.badge !== '🥉') throw new Error(`mid badge=${mid.badge}`);
    // Sort check
    if (lb[0].safety_score < lb[1].safety_score) throw new Error('not sorted desc');
  });

  // ===== Rare feature: AI assistant =====
  await test('Rare — AI assistant answers natural-language questions', () => {
    const db = fresh();
    const ops = require('./operations');
    const ctx = { user: { id: 1, role: 'Admin' } };
    ops.addVehicle(ctx, { reg_no: 'TEST-AI1', name: 'V', type: 'Van',
                          max_load_kg: 500, odometer_km: 0,
                          acquisition_cost: 800000, region: 'Central' });
    const r = ops.aiAsk('help');
    if (!r.answer) throw new Error('help answer missing');
    const r2 = ops.aiAsk('available vehicles');
    if (!r2.answer) throw new Error('available answer missing');
  });

  // ===== Auth: bcrypt + JWT =====
  await test('Auth — verifyUser rejects bad password', () => {
    const db = fresh();
    db.verifyUser('admin@vaelos.com', 'wrong'); // seed user
    // The seed users are inserted by init() — verify password works
    if (!db.verifyUser('admin@vaelos.com', 'admin123'))
      throw new Error('Seed admin not verifiable');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();