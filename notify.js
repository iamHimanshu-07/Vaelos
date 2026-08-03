/**
 * Vaelos - Owner notification transport.
 * Sends signup/login alerts to the owner (itshimanshu666@gmail.com).
 * Transport priority:
 *   1) Resend (if RESEND_API_KEY is set)
 *   2) Fallback: append to ./outbox.log + console.log (for local dev)
 * The transport never throws — notifications are best-effort and must not
 * block signups or logins. Passwords are never accepted into the payload.
 */
const fs = require('fs');
const path = require('path');

const OWNER_EMAIL = process.env.OWNER_EMAIL || 'itshimanshu666@gmail.com';
const RESEND_KEY = process.env.RESEND_API_KEY;
const FROM_ADDR = process.env.VAELOS_FROM || 'Vaelos Alerts <alerts@vaelos.app>';
const OUTBOX = path.join(__dirname, 'outbox.log');

let Resend = null;
if (RESEND_KEY) {
  try { Resend = require('resend').Resend; } catch (_) { /* not installed yet */ }
}

const DEMO_EMAILS = new Set([
  'admin@vaelos.com', 'alex@vaelos.com', 'sarah@vaelos.com', 'felix@vaelos.com',
]);
function isDemoEmail(email) {
  return email && DEMO_EMAILS.has(String(email).toLowerCase());
}

function fallbackLog(kind, body) {
  const line = `[${new Date().toISOString()}] ${kind} ${JSON.stringify(body)}\n`;
  try { fs.appendFileSync(OUTBOX, line); } catch (_) { /* best effort */ }
  console.log('[vaelos][notify]', line.trim());
}

async function sendViaResend(kind, body) {
  if (!RESEND_KEY || !Resend) return false;
  try {
    const client = new Resend(RESEND_KEY);
    const subject = `[Vaelos] ${kind}: ${body.subject || ''}`.trim();
    const text = JSON.stringify(body, null, 2);
    const res = await client.emails.send({
      from: FROM_ADDR, to: OWNER_EMAIL, subject, text,
    });
    if (res && res.error) throw new Error(res.error.message || 'resend error');
    return true;
  } catch (e) {
    fallbackLog(kind, { ...body, resendError: e.message });
    return false;
  }
}

/**
 * notifyOwner('signup' | 'login', payload)
 * payload may include { name, email, role, userId, ip, ua }.
 * Returns { sent: 'resend' | 'fallback', skipped?: boolean }.
 */
async function notifyOwner(kind, payload = {}) {
  // Defence in depth: drop any password field even if a future caller forgets.
  const safe = { ...payload };
  delete safe.password;
  delete safe.pass;
  delete safe.pwd;
  if (safe.email && isDemoEmail(safe.email)) {
    return { sent: 'skipped', reason: 'demo account' };
  }
  const body = {
    kind, owner: OWNER_EMAIL,
    ts: new Date().toISOString(),
    ...safe,
  };
  if (!body.subject) {
    if (kind === 'signup') body.subject = `${safe.email} signed up as ${safe.role}`;
    else if (kind === 'login') body.subject = `${safe.email} signed in`;
    else body.subject = kind;
  }
  const sent = await sendViaResend(kind, body);
  if (!sent) fallbackLog(kind, body);
  return { sent: sent ? 'resend' : 'fallback' };
}

module.exports = { notifyOwner, isDemoEmail };