// SSO handoff from the SAR Systems Hub (systems.sarlogisolutions.com).
// The Hub POSTs a short-lived launch token signed with SSO_SHARED_SECRET; we verify it,
// confirm the email against this dashboard's own users collection (same lookup as the
// Google sign-in), and hand the browser a page that drops the user record into
// sessionStorage for the boot-time tryHubSsoAutoLogin() in index.html.
import crypto from 'crypto';
import { MongoClient } from 'mongodb';

const uri = process.env.MONGO_URI;
const DB = 'sar-usa-ops';
const HUB_ISSUER = 'sar-systems-hub';
const DEFAULT_HUB_ORIGIN = 'https://systems.sarlogisolutions.com';
// Fallback only: the slug the Hub actually launched (staging or production entry)
// comes from the signature-verified token.
const DEFAULT_DASHBOARD_SLUG = 'sar-usa-operations-test';

let client;
async function getClient() {
  if (!client) {
    client = new MongoClient(uri, { maxPoolSize: 5, serverSelectionTimeoutMS: 10000 });
    await client.connect();
  }
  return client;
}

function base64UrlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

function verifyJwtHs256(token, secret) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [headerB64, payloadB64, sigB64] = parts;

  const header = JSON.parse(base64UrlDecode(headerB64).toString('utf8'));
  if (header.alg !== 'HS256') throw new Error('unexpected alg: ' + header.alg);

  const expectedSig = crypto.createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest();
  const actualSig = base64UrlDecode(sigB64);
  if (expectedSig.length !== actualSig.length || !crypto.timingSafeEqual(expectedSig, actualSig)) {
    throw new Error('bad signature');
  }

  const payload = JSON.parse(base64UrlDecode(payloadB64).toString('utf8'));
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || now >= payload.exp) throw new Error('token expired');
  if (payload.iss !== HUB_ISSUER) throw new Error('unexpected issuer: ' + payload.iss);
  return payload;
}

// Only trust a hub_origin the Hub itself could send (production, or one of its own
// Vercel preview/staging deployments), never an arbitrary origin to load a script from.
function sanitizeHubOrigin(raw) {
  if (!raw) return DEFAULT_HUB_ORIGIN;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return DEFAULT_HUB_ORIGIN;
    const host = u.hostname;
    if (host === 'systems.sarlogisolutions.com' ||
        /^dashboards(-[a-z0-9]+)?-git-[a-z0-9-]+-sar-strategy\.vercel\.app$/.test(host)) return u.origin;
  } catch (_) {}
  return DEFAULT_HUB_ORIGIN;
}

const toScript = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

function renderHandoffPage(user, widgetToken, slug, hubOrigin) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Signing in…</title></head>
<body>
  <p>Signing you in…</p>
  <script>
    try {
      sessionStorage.setItem('sar_hub_sso_user', JSON.stringify(${toScript(user)}));
      var widgetToken = ${toScript(widgetToken || '')};
      if (widgetToken) {
        sessionStorage.setItem('sar_hub_widget_token', widgetToken);
        sessionStorage.setItem('sar_hub_current_slug', ${toScript(slug)});
        sessionStorage.setItem('sar_hub_origin', ${toScript(hubOrigin)});
      }
    } catch (e) {}
    location.replace('/');
  </script>
</body></html>`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  const body = req.body || {};
  if (!body.sso_token) return res.status(400).send('Missing sso_token');

  const secret = process.env.SSO_SHARED_SECRET;
  if (!secret) {
    console.error('sso-verify: SSO_SHARED_SECRET is not set');
    return res.status(500).send('Server misconfiguration. Contact your administrator.');
  }

  let payload;
  try {
    payload = verifyJwtHs256(body.sso_token, secret);
  } catch (err) {
    console.error('sso-verify: token verification failed:', err.message);
    return res.status(401).send('Invalid or expired sign-in link. Please return to the Hub and try again.');
  }

  const email = String(payload.email || '').toLowerCase().trim();
  if (!email) return res.status(400).send('Token missing email');

  const tokenSlug = typeof payload.slug === 'string' ? payload.slug.trim() : '';
  const slug = /^[a-z0-9][a-z0-9_-]{0,79}$/i.test(tokenSlug) ? tokenSlug : DEFAULT_DASHBOARD_SLUG;

  try {
    const db = (await getClient()).db(DB);
    const user = await db.collection('users').findOne({ email, active: true });
    if (!user) {
      return res.status(403).send('Access denied. Your account is not registered in this dashboard. Contact your administrator.');
    }

    const profile = { ...user, email, name: user.name || payload.name || email, picture: payload.picture || '' };
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(renderHandoffPage(profile, body.widget_token, slug, sanitizeHubOrigin(body.hub_origin)));
  } catch (err) {
    console.error('sso-verify: lookup error:', err.message);
    return res.status(500).send('Something went wrong. Please try again.');
  }
}
