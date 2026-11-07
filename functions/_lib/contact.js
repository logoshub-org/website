/*
 * Contact form handler: validation, basic spam checks, then send via SMTP.
 *
 * Environment (set in Cloudflare Pages > Settings > Variables and Secrets):
 *   SMTP_USER   required, the mailbox to log in as and send from (secret)
 *   SMTP_PASS   required, its password or app-specific password (secret)
 *   SMTP_HOST   optional, default smtp.zoho.com.au
 *   SMTP_PORT   optional, default 465 (implicit TLS)
 *   CONTACT_TO  optional, where messages are delivered; default SMTP_USER
 */

import { sendMail, isSafeAddress } from './smtp.js';

const MAX_BODY_CHARS = 20000;
const MIN_FILL_MS = 3000;

function reply(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
        },
    });
}

const singleLine = (value) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
const multiLine = (value) =>
    String(value ?? '')
        .replace(/\r\n?/g, '\n')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
        .trim();

export async function handleContact(request, env, connect) {
    // Only accept posts from this same site.
    const origin = request.headers.get('Origin');
    if (origin) {
        let sameSite = false;
        try {
            sameSite = new URL(origin).host === new URL(request.url).host;
        } catch (ignored) {
            sameSite = false;
        }
        if (!sameSite) {
            return reply({ ok: false, error: 'Request not allowed.' }, 403);
        }
    }

    if (!(request.headers.get('Content-Type') || '').includes('application/json')) {
        return reply({ ok: false, error: 'Unsupported request.' }, 415);
    }
    if (Number(request.headers.get('Content-Length') || 0) > MAX_BODY_CHARS) {
        return reply({ ok: false, error: 'Message is too large.' }, 413);
    }

    let data;
    try {
        const raw = await request.text();
        if (raw.length > MAX_BODY_CHARS) {
            return reply({ ok: false, error: 'Message is too large.' }, 413);
        }
        data = JSON.parse(raw);
    } catch (ignored) {
        return reply({ ok: false, error: 'Invalid request.' }, 400);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return reply({ ok: false, error: 'Invalid request.' }, 400);
    }

    // Spam checks. Bots get a fake success so they learn nothing.
    if (data.company_url) {
        return reply({ ok: true });
    }
    const elapsed = Number(data.elapsed);
    if (!Number.isFinite(elapsed)) {
        return reply({ ok: false, error: 'Please turn on JavaScript and try again.' }, 400);
    }
    if (elapsed < MIN_FILL_MS) {
        return reply({ ok: true });
    }

    const name = singleLine(data.name);
    const email = singleLine(data.email);
    const message = multiLine(data.message);

    if (!name || name.length > 100) {
        return reply({ ok: false, error: 'Please enter your name (up to 100 characters).' }, 400);
    }
    if (!isSafeAddress(email)) {
        return reply({ ok: false, error: 'Please enter a valid email address.' }, 400);
    }
    if (message.length < 10 || message.length > 5000) {
        return reply({ ok: false, error: 'Please write a message between 10 and 5000 characters.' }, 400);
    }

    // Secrets pasted into a dashboard often pick up stray spaces or newlines.
    const smtpUser = String(env.SMTP_USER || '').trim();
    const smtpPass = String(env.SMTP_PASS || '').trim();
    const smtpHost = String(env.SMTP_HOST || '').trim() || 'smtp.zoho.com.au';
    const smtpPort = Number(env.SMTP_PORT) || 465;
    const contactTo = String(env.CONTACT_TO || '').trim() || smtpUser;

    if (!smtpUser || !smtpPass) {
        console.error('Contact form: SMTP_USER and SMTP_PASS are not set');
        return reply({ ok: false, error: 'Sorry, the contact form is not available right now.' }, 500);
    }

    const text =
        'New message from the Logos Hub website contact form.\n\n' +
        `Name: ${name}\nEmail: ${email}\n\n${message}\n`;

    try {
        await sendMail({
            connect,
            host: smtpHost,
            port: smtpPort,
            user: smtpUser,
            pass: smtpPass,
            from: smtpUser,
            fromName: 'Logos Hub Website',
            to: contactTo,
            replyTo: { name, email },
            subject: `Website contact: ${name}`,
            text,
            hostname: 'logoshub.org',
        });
        return reply({ ok: true });
    } catch (err) {
        // Never log the password itself; its length is enough to spot a bad paste.
        console.error(
            'Contact form send failed:',
            err && err.message,
            `(login ${JSON.stringify(smtpUser)}, password length ${smtpPass.length}, server ${smtpHost}:${smtpPort})`,
        );
        return reply({ ok: false, error: "Sorry, we couldn't send your message right now. Please try again later." }, 502);
    }
}
