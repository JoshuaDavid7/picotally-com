/**
 * Cloudflare Pages Function — /api/early-access
 *
 * Receives waitlist submissions from the modal on every page. Runs on
 * Cloudflare's own edge network alongside the site itself, so there's
 * no third-party data processor in the middle.
 *
 * Behaviour:
 *   1. Validates the request (POST, JSON, required fields, basic
 *      length / format sanity).
 *   2. Always logs a structured line (visible in Cloudflare Pages →
 *      project → "Functions" / "Real-time logs"). That's the floor —
 *      even with zero additional setup, every submission is captured.
 *   3. If a KV namespace is bound to the project as `EARLY_ACCESS_KV`
 *      (Cloudflare dashboard → Pages → Settings → Functions → KV
 *      namespace bindings), also persists the submission under a
 *      timestamp-prefixed key. That way submissions survive past the
 *      ~30-day log retention window.
 *   4. If `WEBHOOK_URL` is set as an environment variable (Pages →
 *      Settings → Environment variables), also POSTs the submission
 *      to that URL — useful for fan-out to Slack / Discord / Zapier
 *      / Resend / anything else without changing this code.
 *   5. Returns { ok: true } on success so the modal swaps to the
 *      check-mark success state. Returns a 4xx with { ok: false,
 *      error: "..." } on validation errors and a 5xx on unexpected
 *      failures.
 *
 * Setup work needed in Cloudflare dashboard for full functionality:
 *   - KV (recommended): create namespace "EARLY_ACCESS_KV" → bind to
 *     this Pages project. Done in 30 seconds, no signup elsewhere.
 *   - Webhook (optional): set WEBHOOK_URL env var to your preferred
 *     destination. Mailgun, Resend, Slack, Discord, Make.com all
 *     accept a POST.
 *
 * Both are optional — the floor (logging) works the moment this file
 * deploys.
 */

const MAX_NAME = 120;
const MAX_EMAIL = 254;          // RFC 5321 hard limit
const MAX_TRADE = 80;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function clean(value, max) {
  if (typeof value !== 'string') return '';
  // Collapse whitespace, trim, hard-cap length.
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

// The waitlist endpoint. Public by design and needing no configuration —
// which is the whole point. The previous version depended on three separate
// Cloudflare settings (KV, webhook, Resend key), none of which was ever set,
// so every signup went to a log line Cloudflare does not keep. A setup step
// that must be remembered is a step that will eventually be missed.
const WAITLIST_ENDPOINT =
  'https://txtgzycaopcmnfamwuam.supabase.co/functions/v1/join_waitlist';

/**
 * Store a signup durably. Returns {ok} rather than throwing, so the caller
 * decides what the visitor is told.
 *
 * A duplicate is SUCCESS: someone signing up twice has done nothing wrong and
 * is on the list, which is what they wanted.
 */
async function storeSignup(submission) {
  try {
    const res = await fetch(WAITLIST_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: submission.email,
        name: submission.name,
        trade: submission.trade,
      }),
      signal: AbortSignal.timeout(8000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok !== true) {
      return { ok: false, error: res.status + ': ' + JSON.stringify(body).slice(0, 200) };
    }
    return { ok: true, duplicate: body.duplicate === true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err).slice(0, 200) };
  }
}

export async function onRequestPost({ request, env }) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: 'invalid_json' }, 400);
  }

  const name  = clean(payload?.name, MAX_NAME);
  const email = clean(payload?.email, MAX_EMAIL).toLowerCase();
  const trade = clean(payload?.trade, MAX_TRADE);

  if (!name)            return jsonResponse({ ok: false, error: 'name_required' }, 400);
  if (!email)           return jsonResponse({ ok: false, error: 'email_required' }, 400);
  if (!EMAIL_RE.test(email)) return jsonResponse({ ok: false, error: 'email_invalid' }, 400);

  const submission = {
    ts: new Date().toISOString(),
    name,
    email,
    trade: trade || null,
    ip: request.headers.get('cf-connecting-ip') || null,
    ua: request.headers.get('user-agent') || null,
    referer: request.headers.get('referer') || null,
    country: request.cf?.country || null,
  };

  // Floor: always log so submissions show up in Cloudflare's Pages
  // logs even before any KV / webhook is wired up.
  console.log('EARLY_ACCESS_SIGNUP', JSON.stringify(submission));

  // DURABLE STORE. This is the only line here that actually keeps anything.
  //
  // Everything below it — KV, webhook, email — is gated on an environment
  // variable, and on 2026-08-04 not one of the three had ever been set. That
  // meant every signup lived only as the console.log above, which Cloudflare
  // does not retain, while the form cheerfully said "You are on the list".
  //
  // So this deliberately needs NO configuration. The Supabase URL and anon key
  // are public by design (the same pair ships inside the iOS app), and the
  // waitlist table grants anon INSERT and no SELECT — a stranger can join the
  // list and can never read it. A setup step that does not exist cannot be
  // left half-done, which is the entire lesson of the bug this replaces.
  const stored = await storeSignup(submission);
  if (!stored.ok) {
    // Tell the visitor the truth. The old code returned success the moment it
    // started working, so people were told they were on a list that was not
    // recording anything. A visible failure they can act on beats a green tick
    // that means nothing.
    console.error('EARLY_ACCESS_STORE_FAILED', stored.error);
    return jsonResponse({ ok: false, error: 'store_failed' }, 502);
  }

  // Persist to KV if bound. Keyed by epoch ms so a sorted listing is a
  // chronological feed; suffixed by email so a manual lookup is easy.
  if (env.EARLY_ACCESS_KV) {
    try {
      const key = `signup:${Date.now()}:${email}`;
      await env.EARLY_ACCESS_KV.put(key, JSON.stringify(submission), {
        // No expiration — the waitlist is the source of truth.
      });
    } catch (err) {
      // Don't fail the user-facing request if KV write fails — we
      // still have the log line. Just surface it for ops.
      console.error('EARLY_ACCESS_KV_WRITE_FAILED', err?.message || String(err));
    }
  }

  // Optional webhook fan-out. Fire-and-forget so the user doesn't wait
  // on a slow downstream.
  if (env.WEBHOOK_URL) {
    // Note: we don't await this. If WEBHOOK_URL is misconfigured we
    // still want the signup to land in KV / logs.
    fetch(env.WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `New PicoTally waitlist signup: ${name} <${email}>${trade ? ', ' + trade : ''}`,
        submission,
      }),
    }).catch((err) => {
      console.error('EARLY_ACCESS_WEBHOOK_FAILED', err?.message || String(err));
    });
  }

  // Optional Resend email delivery. If RESEND_API_KEY is set, every
  // submission also gets emailed as a plain notification. Sign up
  // at resend.com (free, 100 emails/day), paste the API key as a
  // Cloudflare Pages env var named RESEND_API_KEY. Optionally set
  // RESEND_TO (default: support@picotally.com) and RESEND_FROM
  // (default: PicoTally Waitlist <onboarding@resend.dev>, which
  // works without verifying picotally.com as a sending domain).
  if (env.RESEND_API_KEY) {
    const to = env.RESEND_TO || 'support@picotally.com';
    const from = env.RESEND_FROM || 'PicoTally Waitlist <onboarding@resend.dev>';
    const safeName = String(name).replace(/[<>&]/g, '');
    const safeEmail = String(email).replace(/[<>&]/g, '');
    const safeTrade = (trade ? String(trade).replace(/[<>&]/g, '') : '(not specified)');
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to,
        reply_to: safeEmail,
        subject: `New PicoTally early access: ${safeName}`,
        html: `<h2>New waitlist signup</h2>
<p><strong>Name:</strong> ${safeName}</p>
<p><strong>Email:</strong> <a href="mailto:${safeEmail}">${safeEmail}</a></p>
<p><strong>Trade:</strong> ${safeTrade}</p>
<p><strong>When:</strong> ${submission.ts}</p>
<p><strong>Country:</strong> ${submission.country || 'unknown'}</p>
<hr>
<p style="color:#888;font-size:12px;">Sent by the picotally.com Cloudflare Pages Function. Reply to this email to respond to ${safeName} directly.</p>`,
      }),
    }).then(async (r) => {
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        console.error('EARLY_ACCESS_RESEND_FAILED', r.status, body.slice(0, 200));
        return;
      }
      // Tell PicoTally's monitoring we just used one of the shared Resend
      // allowance. This site and the app's backend send through the SAME
      // Resend account (~100/day on the free tier), but the app counts only
      // its own sends — so without this line the monitoring undercounts the
      // exact number it exists to protect. The failure it guards against is
      // nasty and silent: cross the cap and new signups simply never receive
      // their confirmation email, with nothing erroring anywhere.
      await reportOpsUsage(env, 'resend', 'emails', 1);
    }).catch((err) => {
      console.error('EARLY_ACCESS_RESEND_FAILED', err?.message || String(err));
    });
  }

  return jsonResponse({ ok: true });
}

/**
 * Report consumption of a shared third-party allowance to PicoTally's
 * monitoring, so counters cover every sender rather than only the ones living
 * inside Supabase.
 *
 * Deliberately best-effort and non-blocking. A counter is telemetry, not
 * business logic: if this fails, the waitlist signup must still succeed and
 * the visitor must never see a difference. Losing one tick of a counter is a
 * rounding error; failing a signup because a metrics call timed out is a real
 * outage, and this is a growth-critical form.
 *
 * Needs two Cloudflare Pages environment variables. If either is unset this is
 * a silent no-op, so the site keeps working with no setup:
 *   OPS_REPORT_URL     https://<project>.supabase.co/functions/v1/ops_usage_report
 *   OPS_REPORT_SECRET  ops_cron_auth.report_secret from the PicoTally database
 *
 * The endpoint is write-only, can touch only meters the monitoring already
 * tracks, and reads nothing back — so this secret is about as low-value as a
 * credential gets. It is still kept out of the repo, in Cloudflare's env.
 */
async function reportOpsUsage(env, service, metric, units) {
  if (!env.OPS_REPORT_URL || !env.OPS_REPORT_SECRET) return;
  try {
    const res = await fetch(env.OPS_REPORT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ops-report-secret': env.OPS_REPORT_SECRET,
      },
      body: JSON.stringify({ service, metric, units }),
      // Never let a slow monitoring endpoint hold the request open.
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      console.error('OPS_USAGE_REPORT_FAILED', res.status);
    }
  } catch (err) {
    console.error('OPS_USAGE_REPORT_FAILED', err?.message || String(err));
  }
}

// Anything other than POST gets a polite 405 — keeps random GET probes
// from looking like real submissions in the logs.
export async function onRequest({ request }) {
  if (request.method === 'POST') {
    // Should be handled by onRequestPost above; if we land here it's
    // because of a routing oddity — fall through.
    return onRequestPost(arguments[0]);
  }
  return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405);
}
