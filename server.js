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

const { init, verifyUser, recomputeLicenseNotifications } = require('./database');
const ops = require('./operations');

console.log('[vaelos] booting…');
console.log(`[vaelos] node ${process.version} | pid ${process.pid} | cwd ${process.cwd()}`);
console.log(`[vaelos] env PORT=${process.env.PORT || '(unset, will use 3000)'} | NODE_ENV=${process.env.NODE_ENV || '(unset)'}`);

try {
  init();
  recomputeLicenseNotifications();
  console.log('[vaelos] database initialised ok');
} catch (err) {
  console.error('[vaelos] FATAL: database init failed:', err && err.stack || err);
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use(cookieParser());

const JWT_SECRET = process.env.JWT_SECRET || 'vaelos-dev-secret-change-me';

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
    if (!req.user || !roles.includes(req.user.role))
      return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}

// helper: broadcast after every mutation
function ctx(req) { return { user: req.user }; }
function broadcast(action, entity, id, message) {
  liveHub.broadcast(action, { entity, id, message });
}

// ----------------------------- AUTH ----------------------------- //
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email & password required' });
  const user = verifyUser(email, password);
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });
  const token = jwt.sign(
    { id: user.id, email: user.email, name: user.name, role: user.role },
    JWT_SECRET, { expiresIn: '12h' }
  );
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax' });
  res.json({ user, token });
});
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token'); res.json({ ok: true });
});
app.get('/api/auth/me', authRequired, (req, res) => res.json({ user: req.user }));

// ----------------------------- USERS ----------------------------- //
app.get('/api/users', authRequired, requireRole('Fleet Manager'), (req, res) =>
  res.json(ops.listUsers()));
app.post('/api/users', authRequired, requireRole('Fleet Manager'), (req, res) => {
  try { ops.addUser(ctx(req), req.body); broadcast('user.create'); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/users/:id', authRequired, requireRole('Fleet Manager'), (req, res) => {
  ops.deleteUser(ctx(req), +req.params.id); broadcast('user.delete'); res.json({ ok: true });
});

// ----------------------------- VEHICLES ----------------------------- //
app.get('/api/vehicles', authRequired, (req, res) => res.json(ops.listVehicles(req.query)));
app.get('/api/vehicles/:id', authRequired, (req, res) => {
  const v = ops.getVehicle(+req.params.id);
  if (!v) return res.status(404).json({ error: 'Not found' });
  res.json(v);
});
app.post('/api/vehicles', authRequired, (req, res) => {
  try { ops.addVehicle(ctx(req), req.body); broadcast('vehicle.create'); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/vehicles/:id', authRequired, (req, res) => {
  try { ops.updateVehicle(ctx(req), +req.params.id, req.body); broadcast('vehicle.update'); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/vehicles/:id', authRequired, (req, res) => {
  try { ops.deleteVehicle(ctx(req), +req.params.id); broadcast('vehicle.delete'); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ----------------------------- DRIVERS ----------------------------- //
app.get('/api/drivers', authRequired, (req, res) => res.json(ops.listDrivers(req.query)));
app.get('/api/drivers/:id', authRequired, (req, res) => {
  const d = ops.getDriver(+req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  res.json(d);
});
app.post('/api/drivers', authRequired, (req, res) => {
  try { ops.addDriver(ctx(req), req.body); broadcast('driver.create'); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/drivers/:id', authRequired, (req, res) => {
  try { ops.updateDriver(ctx(req), +req.params.id, req.body); broadcast('driver.update'); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/drivers/:id', authRequired, (req, res) => {
  try { ops.deleteDriver(ctx(req), +req.params.id); broadcast('driver.delete'); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ----------------------------- TRIPS ----------------------------- //
app.get('/api/trips', authRequired, (req, res) => res.json(ops.listTrips(req.query)));
app.post('/api/trips', authRequired, (req, res) => {
  const [ok, msg] = ops.createTrip(ctx(req), req.body);
  if (!ok) return res.status(400).json({ error: msg });
  broadcast('trip.create'); res.json({ ok: true, message: msg });
});
app.post('/api/trips/:id/dispatch', authRequired, (req, res) => {
  const [ok, msg] = ops.dispatchTrip(ctx(req), +req.params.id);
  if (!ok) return res.status(400).json({ error: msg });
  broadcast('trip.dispatch'); res.json({ ok: true, message: msg });
});
app.post('/api/trips/:id/complete', authRequired, (req, res) => {
  const [ok, msg] = ops.completeTrip(ctx(req), +req.params.id, req.body);
  if (!ok) return res.status(400).json({ error: msg });
  broadcast('trip.complete'); res.json({ ok: true, message: msg });
});
app.post('/api/trips/:id/cancel', authRequired, (req, res) => {
  const [ok, msg] = ops.cancelTrip(ctx(req), +req.params.id);
  if (!ok) return res.status(400).json({ error: msg });
  broadcast('trip.cancel'); res.json({ ok: true, message: msg });
});

// ----------------------------- MAINTENANCE ----------------------------- //
app.get('/api/maintenance', authRequired, (req, res) =>
  res.json(ops.listMaintenance(req.query.vehicle_id ? +req.query.vehicle_id : null)));
app.post('/api/maintenance', authRequired, (req, res) => {
  const [ok, msg] = ops.createMaintenance(ctx(req), req.body);
  if (!ok) return res.status(400).json({ error: msg });
  broadcast('maintenance.create'); res.json({ ok: true, message: msg });
});
app.post('/api/maintenance/:id/close', authRequired, (req, res) => {
  const [ok, msg] = ops.closeMaintenance(ctx(req), +req.params.id);
  if (!ok) return res.status(400).json({ error: msg });
  broadcast('maintenance.close'); res.json({ ok: true, message: msg });
});
app.delete('/api/maintenance/:id', authRequired, (req, res) => {
  ops.deleteMaintenance(ctx(req), +req.params.id); res.json({ ok: true });
});

// ----------------------------- FUEL & EXPENSES ----------------------------- //
app.get('/api/fuel', authRequired, (req, res) =>
  res.json(ops.listFuel(req.query.vehicle_id ? +req.query.vehicle_id : null)));
app.post('/api/fuel', authRequired, (req, res) => {
  ops.addFuel(ctx(req), req.body); res.json({ ok: true });
});
app.get('/api/expenses', authRequired, (req, res) =>
  res.json(ops.listExpenses(req.query.vehicle_id ? +req.query.vehicle_id : null)));
app.post('/api/expenses', authRequired, (req, res) => {
  ops.addExpense(ctx(req), req.body); res.json({ ok: true });
});

// ----------------------------- ANALYTICS & EXTRA ----------------------------- //
app.get('/api/kpis', authRequired, (req, res) => res.json(ops.dashboardKpis()));
app.get('/api/metrics', authRequired, (req, res) => res.json(ops.vehicleMetrics()));
app.get('/api/notifications', authRequired, (req, res) => res.json(ops.listNotifications()));
app.post('/api/notifications/read-all', authRequired, (req, res) => {
  ops.markAllNotificationsRead(); res.json({ ok: true });
});
app.get('/api/audit', authRequired, (req, res) => res.json(ops.listAudit(+req.query.limit || 100)));
app.get('/api/predictive-maintenance', authRequired, (req, res) =>
  res.json(ops.predictiveMaintenance()));
app.get('/api/leaderboard', authRequired, (req, res) =>
  res.json(ops.driverLeaderboard()));
app.post('/api/ai', authRequired, (req, res) => {
  const { question } = req.body || {};
  res.json(ops.aiAsk(question));
});

// ----------------------------- Static frontend ----------------------------- //
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

// WebSocket server for live updates
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  liveHub.wsClients.add(ws);
  ws.send(JSON.stringify({ event: 'connected', data: { msg: 'live' }, ts: Date.now() }));
  ws.on('close', () => liveHub.wsClients.delete(ws));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[vaelos] listening on 0.0.0.0:${PORT}`);
  console.log(`[vaelos] HTTP:  http://0.0.0.0:${PORT}`);
  console.log(`[vaelos] WS:    ws://0.0.0.0:${PORT}/ws`);
});

process.on('uncaughtException', (err) => {
  console.error('[vaelos] uncaughtException:', err && err.stack || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[vaelos] unhandledRejection:', reason);
});
