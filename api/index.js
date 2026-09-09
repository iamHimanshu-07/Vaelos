/**
 * Vaelos - Express server + WebSocket live updates.
 * Serves the static frontend and a JSON API for all operations.
 */
const path = require('path');
const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');

const { init, verifyUser, recomputeLicenseNotifications, pool,
        isDemoEmail, ensureDemoClone } = require('../database');
const ops = require('../operations');
const { notifyOwner } = require('../notify');

console.log('[vaelos] booting…');
console.log(`[vaelos] node ${process.version} | pid ${process.pid} | cwd ${process.cwd()}`);
console.log(`[vaelos] env PORT=${process.env.PORT || '(unset)'} | NODE_ENV=${process.env.NODE_ENV || '(unset)'}`);

async function boot() {
  try {
    await init();
    await recomputeLicenseNotifications();
    console.log('[vaelos] database initialised ok');
  } catch (err) {
    console.error('[vaelos] FATAL: database init failed:', err && err.stack || err);
    process.exit(1);
  }
}

boot();

const app = express();
app.use(express.json());
app.use(cookieParser());

const JWT_SECRET = process.env.JWT_SECRET || 'vaelos-dev-secret-change-me';
const OWNER_EMAIL = 'itshimanshu666@gmail.com';

// Simple live-broadcast hub
const liveHub = {
  wsClients: new Set(),
  broadcast(event, data) {
    const payload = JSON.stringify({ event, data, ts: Date.now() });
    for (const ws of this.wsClients) {
      try { ws.send(payload); } catch {}
    }
  },
};

function authRequired(req, res, next) {
  const token = req.cookies?.token ||
                (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { return res.status(401).json({ error: 'Invalid token' }); }
}
function requireRole(...roles) {
  return (req, res, next) => {
    const userRole = req.user?.role;
    if (!userRole || !roles.some(r => r.toLowerCase() === String(userRole).toLowerCase())) {
      console.warn(`[auth] Access denied for user ${req.user?.email} (Role: ${userRole}) to role-protected route. Required: ${roles.join(', ')}`);
      return res.status(403).json({ error: 'Forbidden: Admin access required' });
    }
    next();
  };
}

function requireOwner(req, res, next) {
  if (req.user?.email?.toLowerCase() !== OWNER_EMAIL.toLowerCase()) {
    console.warn(`[auth] Owner-only access denied for user ${req.user?.email}`);
    return res.status(403).json({ error: 'Forbidden: Owner access required' });
  }
  next();
}

// helper: broadcast after every mutation
function ctx(req) { return { user: req.user }; }
function broadcast(action, entity, id, message) {
  liveHub.broadcast(action, { entity, id, message });
}

// ----------------------------- AUTH ----------------------------- //
const signupRate = new Map(); // email -> count (in-memory, sufficient for demo)
function rateLimit(key, max = 5, windowMs = 60_000) {
  const now = Date.now();
  const arr = (signupRate.get(key) || []).filter(t => now - t < windowMs);
  arr.push(now);
  signupRate.set(key, arr);
  return arr.length <= max;
}

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email & password required' });
  if (!rateLimit('login:' + email.toLowerCase())) return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
  const user = await verifyUser(email, password);
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });
  // For demo accounts, ensure an isolated clone exists for this email before
  // the very first read so the workspace is ready.
  if (isDemoEmail(user.email)) await ensureDemoClone(user.email);
  const token = jwt.sign(
    { id: user.id, email: user.email, name: user.name, role: user.role },
    JWT_SECRET, { expiresIn: '12h' });
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax' });
  res.json({ user, token });
  // Fire-and-forget owner notification. Never blocks the response.
  notifyOwner('login', {
    userId: user.id, name: user.name, email: user.email, role: user.role,
    ip: req.ip, ua: req.headers['user-agent'],
  }).catch(() => {});
});
app.post('/api/auth/signup', async (req, res) => {
  const { name, email, password, role } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, and password are required.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email address.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (!rateLimit('signup:' + email.toLowerCase(), 3, 5 * 60_000)) return res.status(429).json({ error: 'Too many signup attempts. Try again in 5 minutes.' });
  // First-ever user becomes Admin; everyone else is Driver by default.
  const existing = await ops.listUsers();
  const finalRole = (existing.length === 0) ? 'Admin'
                  : (['Driver','Admin'].includes(role) ? role : 'Driver');
  try {
    await ops.addUser(ctx(req), { name: name.trim(), email: email.trim().toLowerCase(), password, role: finalRole });
    const userRes = await pool.query('SELECT id, name, email, role FROM users WHERE email = $1', [email.trim().toLowerCase()]);
    const created = userRes.rows[0];
    res.json({ ok: true, user: created });
    notifyOwner('signup', {
      name, email: email.trim().toLowerCase(), role: finalRole,
      ip: req.ip, ua: req.headers['user-agent'],
    }).catch(() => {});
  } catch (e) {
    const msg = String(e.message || '');
    if (msg.includes('UNIQUE') && msg.includes('email'))
      return res.status(409).json({ error: 'An account with that email already exists. Try signing in.' });
    return res.status(400).json({ error: msg });
  }
});
app.post('/api/auth/forgot', (req, res) => {
  return res.json({ ok: true, message: 'If an account exists for that email, a reset link will be sent. (Demo mode: contact an Admin.)' });
});
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token'); res.json({ ok: true });
});
app.get('/api/auth/me', authRequired, (req, res) => res.json({ user: req.user }));

// ----------------------------- USERS ----------------------------- //
app.get('/api/users', authRequired, requireOwner, async (req, res) =>
  res.json(await ops.listUsers()));
app.post('/api/users', authRequired, requireOwner, async (req, res) => {
  try { await ops.addUser(ctx(req), req.body); broadcast('user.create'); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/users/:id', authRequired, requireOwner, async (req, res) => {
  await ops.deleteUser(ctx(req), +req.params.id); broadcast('user.delete'); res.json({ ok: true });
});

// ----------------------------- VEHICLES ----------------------------- //
app.get('/api/vehicles', authRequired, async (req, res) => res.json(await ops.listVehicles(req.query, req.user.email)));
app.get('/api/vehicles/:id', authRequired, async (req, res) => {
  const v = await ops.getVehicle(+req.params.id);
  if (!v) return res.status(404).json({ error: 'Not found' });
  res.json(v);
});
app.post('/api/vehicles', authRequired, async (req, res) => {
  try { await ops.addVehicle(ctx(req), req.body); broadcast('vehicle.create'); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/vehicles/:id', authRequired, async (req, res) => {
  try { await ops.updateVehicle(ctx(req), +req.params.id, req.body); broadcast('vehicle.update'); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/vehicles/:id', authRequired, async (req, res) => {
  try { await ops.deleteVehicle(ctx(req), +req.params.id); broadcast('vehicle.delete'); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ----------------------------- DRIVERS ----------------------------- //
app.get('/api/drivers', authRequired, async (req, res) => res.json(await ops.listDrivers(req.query, req.user.email)));
app.get('/api/drivers/:id', authRequired, async (req, res) => {
  const d = await ops.getDriver(+req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  res.json(d);
});
app.post('/api/drivers', authRequired, async (req, res) => {
  try { await ops.addDriver(ctx(req), req.body); broadcast('driver.create'); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/drivers/:id', authRequired, async (req, res) => {
  try { await ops.updateDriver(ctx(req), +req.params.id, req.body); broadcast('driver.update'); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/drivers/:id', authRequired, async (req, res) => {
  try { await ops.deleteDriver(ctx(req), +req.params.id); broadcast('driver.delete'); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ----------------------------- TRIPS ----------------------------- //
app.get('/api/trips', authRequired, async (req, res) => res.json(await ops.listTrips(req.query, req.user.email)));
app.post('/api/trips', authRequired, async (req, res) => {
  const [ok, msg] = await ops.createTrip(ctx(req), req.body);
  if (!ok) return res.status(400).json({ error: msg });
  broadcast('trip.create'); res.json({ ok: true, message: msg });
});
app.post('/api/trips/:id/dispatch', authRequired, async (req, res) => {
  const [ok, msg] = await ops.dispatchTrip(ctx(req), +req.params.id);
  if (!ok) return res.status(400).json({ error: msg });
  broadcast('trip.dispatch'); res.json({ ok: true, message: msg });
});
app.post('/api/trips/:id/complete', authRequired, async (req, res) => {
  const [ok, msg] = await ops.completeTrip(ctx(req), +req.params.id, req.body);
  if (!ok) return res.status(400).json({ error: msg });
  broadcast('trip.complete'); res.json({ ok: true, message: msg });
});
app.post('/api/trips/:id/cancel', authRequired, async (req, res) => {
  const [ok, msg] = await ops.cancelTrip(ctx(req), +req.params.id);
  if (!ok) return res.status(400).json({ error: msg });
  broadcast('trip.cancel'); res.json({ ok: true, message: msg });
});

// ----------------------------- MAINTENANCE ----------------------------- //
app.get('/api/maintenance', authRequired, async (req, res) =>
  res.json(await ops.listMaintenance(req.query.vehicle_id ? +req.query.vehicle_id : null, req.user.email)));
app.post('/api/maintenance', authRequired, async (req, res) => {
  const [ok, msg] = await ops.createMaintenance(ctx(req), req.body);
  if (!ok) return res.status(400).json({ error: msg });
  broadcast('maintenance.create'); res.json({ ok: true, message: msg });
});
app.post('/api/maintenance/:id/close', authRequired, async (req, res) => {
  const [ok, msg] = await ops.closeMaintenance(ctx(req), +req.params.id);
  if (!ok) return res.status(400).json({ error: msg });
  broadcast('maintenance.close'); res.json({ ok: true, message: msg });
});
app.delete('/api/maintenance/:id', authRequired, async (req, res) => {
  await ops.deleteMaintenance(ctx(req), +req.params.id); res.json({ ok: true });
});

// ----------------------------- FUEL & EXPENSES ----------------------------- //
app.get('/api/fuel', authRequired, async (req, res) =>
  res.json(await ops.listFuel(req.query.vehicle_id ? +req.query.vehicle_id : null, req.user.email)));
app.post('/api/fuel', authRequired, async (req, res) => {
  const [ok, msg] = await ops.addFuel(ctx(req), req.body);
  if (!ok) return res.status(403).json({ error: msg });
  res.json({ ok: true, message: msg });
});
app.get('/api/expenses', authRequired, async (req, res) =>
  res.json(await ops.listExpenses(req.query.vehicle_id ? +req.query.vehicle_id : null, req.user.email)));
app.post('/api/expenses', authRequired, async (req, res) => {
  const [ok, msg] = await ops.addExpense(ctx(req), req.body);
  if (!ok) return res.status(403).json({ error: msg });
  res.json({ ok: true, message: msg });
});

// ----------------------------- ANALYTICS & EXTRA ----------------------------- //
app.get('/api/kpis', authRequired, async (req, res) => res.json(await ops.dashboardKpis(req.user.email)));
app.get('/api/metrics', authRequired, async (req, res) => res.json(await ops.vehicleMetrics(req.user.email)));
app.get('/api/notifications', authRequired, async (req, res) =>
  res.json(await ops.listNotifications(req.user.email)));
app.post('/api/notifications/read-all', authRequired, async (req, res) => {
  await ops.markAllNotificationsRead(req.user.email); res.json({ ok: true });
});
app.get('/api/audit', authRequired, requireOwner, async (req, res) => {
  const wantAll = String(req.query.scope || '').toLowerCase() === 'all';
  const isOwner = String(req.user.email || '').toLowerCase() === OWNER_EMAIL.toLowerCase();
  const scope = (wantAll && isOwner) ? 'all' : 'me';
  try {
    const rows = await ops.listAudit(+req.query.limit || 100, { scope, actorEmail: req.user.email });
    res.json(Array.isArray(rows) ? rows : []);
  } catch (e) {
    console.error('[vaelos] /api/audit failed:', e && e.message || e);
    res.status(500).json({ error: 'Failed to load audit log' });
  }
});
app.get('/api/predictive-maintenance', authRequired, async (req, res) =>
  res.json(await ops.predictiveMaintenance(req.user.email)));
app.get('/api/leaderboard', authRequired, async (req, res) =>
  res.json(await ops.driverLeaderboard(req.user.email)));
app.get('/api/search', authRequired, async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.json({ vehicles: [], drivers: [], trips: [], maintenance: [] });
  const score = (val) => {
    const s = String(val || '').toLowerCase();
    if (!s) return 0;
    if (s === q) return 100;
    if (s.startsWith(q)) return 80;
    if (s.includes(q)) return 50;
    return 0;
  };
  const top = (arr, fields) => arr
    .map(item => ({ item, sc: Math.max(...fields.map(f => score(item[f]))) }))
    .filter(x => x.sc > 0)
    .sort((a, b) => b.sc - a.sc)
    .slice(0, 10)
    .map(x => x.item);
  res.json({
    vehicles:     top(await ops.listVehicles({},     req.user.email), ['reg_no', 'name', 'type', 'region', 'status']),
    drivers:      top(await ops.listDrivers({},      req.user.email), ['name', 'license_no', 'contact', 'license_category', 'status']),
    trips:        top(await ops.listTrips({},        req.user.email), ['id', 'source', 'destination', 'vehicle_reg', 'driver_name', 'status']),
    maintenance:  top(await ops.listMaintenance(null, req.user.email), ['vehicle_reg', 'description', 'notes', 'status']),
  });
});
app.post('/api/ai', authRequired, async (req, res) => {
  const { question } = req.body || {};
  res.json(await ops.aiAsk(question));
});

const APP_VERSION = require('../package.json').version;
const RELEASE_NAME = require('../package.json').releaseName || `Vaelos v${APP_VERSION}`;
app.get('/api/build', (_req, res) => res.json({
  version: APP_VERSION,
  name: RELEASE_NAME,
  node: process.version,
  started: new Date(Date.now() - Math.floor(process.uptime() * 1000)).toISOString(),
}));

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true, ts: Date.now() });
});
app.get('/healthz', (_req, res) => {
  res.status(200).end();
});
app.get('/api/health-stats', async (_req, res) => {
  try {
    const vRes = await pool.query('SELECT COUNT(*) c FROM vehicles');
    const tRes = await pool.query('SELECT COUNT(*) c FROM trips');
    const dRes = await pool.query('SELECT COUNT(*) c FROM drivers');
    res.json({ vehicles: vRes.rows[0].c, trips: tRes.rows[0].c, drivers: dRes.rows[0].c });
  } catch (e) {
    res.json({ vehicles: 0, trips: 0, drivers: 0 });
  }
});

app.use(express.static(path.join(__dirname, '../public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public', 'index.html')));

const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

let wss = null;
try {
  wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    liveHub.wsClients.add(ws);
    ws.send(JSON.stringify({ event: 'connected', data: { msg: 'live' }, ts: Date.now() }));
    ws.on('close', () => liveHub.wsClients.delete(ws));
  });
  console.log('[vaelos] websocket server attached at /ws');
} catch (err) {
  console.error('[vaelos] WARNING: websocket init failed (HTTP will still serve):', err && err.message || err);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[vaelos] listening on 0.0.0.0:${PORT}`);
  console.log(`[vaelos] HTTP:  http://0.0.0.0:${PORT}`);
  console.log(`[vaelos] WS:    ws://0.0.0.0:${PORT}/ws`);
  console.log(`[vaelos] healthcheck: GET /healthz → 200 OK`);
});

process.on('uncaughtException', (err) => {
  console.error('[vaelos] uncaughtException:', err && err.stack || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[vaelos] unhandledRejection:', reason);
});
