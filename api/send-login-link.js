// POST /api/send-login-link  { email }  ->  { ok: true }
//
// Mints a Supabase one-time login code and delivers it with Resend.
//
// Why a code and not a tappable link: on iOS, a link tapped in Mail opens
// Safari, and a home-screen PWA has its own separate storage. The session
// would land in the wrong place and the installed app would still be signed
// out. A typed code lands wherever it's typed. It also means we never depend
// on Supabase's Site URL / redirect allow-list being configured.
//
// The service key never leaves this function, and the code is never returned
// in the HTTP response — the only way to learn it is to receive the email.

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

// Best-effort throttle. Serverless instances are recycled, so this is a speed
// bump rather than a guarantee; ALLOWED_EMAILS is the real control.
const recent = new Map();
const THROTTLE_MS = 20_000;

function clean(email) {
  return String(email || '').trim().toLowerCase();
}
function looksLikeEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 254;
}

function emailHtml(code, appUrl) {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#F5E9D4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="max-width:460px;margin:0 auto;padding:32px 24px;">
    <div style="text-align:center;font-size:34px;line-height:1;margin-bottom:6px;">🌊</div>
    <h1 style="margin:0 0 6px;text-align:center;font-size:21px;font-weight:600;color:#2C4A63;">Mood Journal</h1>
    <p style="margin:0 0 26px;text-align:center;font-size:13px;color:#5B8FB0;">Here's your sign-in code</p>

    <div style="background:#FBF5E9;border-radius:22px;padding:26px 20px;text-align:center;">
      <div style="font-size:34px;letter-spacing:9px;font-weight:700;color:#2C4A63;font-variant-numeric:tabular-nums;">${code}</div>
      <p style="margin:16px 0 0;font-size:12.5px;color:#5B8FB0;line-height:1.5;">
        Type this into the app to sign in.<br>It expires in about an hour.
      </p>
    </div>

    <p style="margin:24px 0 0;text-align:center;font-size:11.5px;color:#8FA8BC;line-height:1.6;">
      Didn't ask for this? Ignore this email — nothing happens without the code.<br>
      <a href="${appUrl}" style="color:#5B8FB0;">${appUrl.replace(/^https?:\/\//, '')}</a>
    </p>
  </div>
</body></html>`;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Use POST.' });
  }

  const SUPABASE_URL = process.env.SUPABASE_PROJECT_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SECRET_KEY;
  const RESEND_KEY   = process.env.RESEND_API_KEY;
  const MAIL_FROM    = process.env.MAIL_FROM || 'Mood Journal <onboarding@resend.dev>';
  const APP_URL      = process.env.APP_URL || 'https://mood-journal-ania.vercel.app';

  if (!SUPABASE_URL || !SERVICE_KEY || !RESEND_KEY) {
    console.error('missing env', {
      url: !!SUPABASE_URL, key: !!SERVICE_KEY, resend: !!RESEND_KEY
    });
    return res.status(500).json({ error: 'Sign-in is not configured yet.' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const email = clean(body && body.email);

  if (!looksLikeEmail(email)) {
    return res.status(400).json({ error: "That doesn't look like an email address." });
  }

  // Supabase auto-creates a user for any address we generate a link for, so
  // without this an open endpoint would let anyone create accounts.
  const allowed = (process.env.ALLOWED_EMAILS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (allowed.length && !allowed.includes(email)) {
    // Deliberately vague, and shaped like success, so this can't be used to
    // enumerate which addresses are registered.
    console.warn('blocked non-allowlisted email');
    return res.status(200).json({ ok: true });
  }

  const last = recent.get(email);
  if (last && Date.now() - last < THROTTLE_MS) {
    return res.status(429).json({ error: 'Just sent one — check your inbox, then try again in a moment.' });
  }
  recent.set(email, Date.now());
  if (recent.size > 500) recent.clear();

  // Shared limit across every serverless instance. Sign-up is open, so this is
  // what actually stops someone burning the mail quota or filling auth.users.
  const rateOk = async (key, limit, windowSeconds) => {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/rate_hit`, {
        method: 'POST',
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ p_key: key, p_limit: limit, p_window: windowSeconds })
      });
      if (!r.ok) return true;          // limiter unavailable — don't lock people out
      return (await r.json()) === true;
    } catch { return true; }
  };

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const [emailOk, ipOk] = await Promise.all([
    rateOk('email:' + email, 3, 600),
    rateOk('ip:' + ip, 12, 3600)
  ]);
  if (!emailOk || !ipOk) {
    return res.status(429).json({ error: 'Too many sign-in emails just now. Try again in a little while.' });
  }

  try {
    const genRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ type: 'magiclink', email })
    });

    const gen = await genRes.json().catch(() => ({}));
    if (!genRes.ok) {
      console.error('generate_link failed', genRes.status, gen && (gen.msg || gen.error_code));
      return res.status(502).json({ error: 'Could not start sign-in. Try again in a minute.' });
    }

    const code = (gen.properties && gen.properties.email_otp) || gen.email_otp;
    if (!code) {
      console.error('no email_otp in generate_link response');
      return res.status(502).json({ error: 'Could not start sign-in. Try again in a minute.' });
    }

    const mailRes = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: MAIL_FROM,
        to: [email],
        subject: `${code} is your Mood Journal code`,
        html: emailHtml(code, APP_URL),
        text: `Your Mood Journal sign-in code is ${code}. It expires in about an hour.`
      })
    });

    if (!mailRes.ok) {
      const detail = await mailRes.text().catch(() => '');
      console.error('resend failed', mailRes.status, detail.slice(0, 400));
      // 403 from Resend almost always means the from-address domain isn't
      // verified, or the test sender can only reach the account owner.
      const hint = mailRes.status === 403
        ? 'The email service rejected that address. On a Resend test sender you can only email your own account address.'
        : 'Could not send the email. Try again in a minute.';
      return res.status(502).json({ error: hint });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('send-login-link crashed', err);
    return res.status(500).json({ error: 'Something went wrong sending that. Try again.' });
  }
};
