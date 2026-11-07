/*
 * Minimal SMTP client for Cloudflare Workers / Pages Functions.
 *
 * - Implicit TLS only (port 465). STARTTLS on 587 is not implemented.
 * - AUTH LOGIN, one recipient, plain-text message.
 * - The socket opener is passed in (`connect`), so this file has no
 *   Cloudflare-specific imports and can be tested anywhere.
 *
 * This file has no onRequest* exports, so Pages does not turn it into a route.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** UTF-8 safe base64. */
export function toBase64(text) {
    const bytes = encoder.encode(text);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

/** Dot-stuffing for the DATA command (a leading "." on a line becomes ".."). */
export function dotStuff(message) {
    return message.replace(/^\./gm, '..');
}

const SAFE_ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

export function isSafeAddress(address) {
    return typeof address === 'string' && address.length <= 254 && SAFE_ADDRESS.test(address);
}

function assertAddress(address, label) {
    if (!isSafeAddress(address)) {
        throw new Error(`Invalid ${label} address`);
    }
}

/** Header text: ASCII passes through, anything else becomes RFC 2047 encoded-words. */
export function encodeWords(value) {
    const clean = String(value).replace(/[\r\n]+/g, ' ').trim();
    if (/^[\x20-\x7e]*$/.test(clean)) {
        return clean;
    }
    const words = [];
    let current = '';
    let size = 0;
    for (const ch of clean) {
        const bytes = encoder.encode(ch).length;
        if (size + bytes > 45) {
            words.push(current);
            current = '';
            size = 0;
        }
        current += ch;
        size += bytes;
    }
    if (current) {
        words.push(current);
    }
    return words.map((w) => `=?UTF-8?B?${toBase64(w)}?=`).join('\r\n ');
}

/** "Name" <address> with the name quoted or encoded as needed. */
export function formatAddress(name, email) {
    const clean = String(name || '').replace(/[\r\n]+/g, ' ').trim();
    if (!clean) {
        return `<${email}>`;
    }
    if (/^[\x20-\x7e]*$/.test(clean)) {
        return `"${clean.replace(/(["\\])/g, '\\$1')}" <${email}>`;
    }
    return `${encodeWords(clean)} <${email}>`;
}

export function buildMessage({ from, fromName, to, replyTo, subject, text }) {
    const domain = from.split('@')[1];
    const id = globalThis.crypto && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const headers = [
        `From: ${formatAddress(fromName, from)}`,
        `To: <${to}>`,
        replyTo ? `Reply-To: ${formatAddress(replyTo.name, replyTo.email)}` : null,
        `Subject: ${encodeWords(subject)}`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: <${id}@${domain}>`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
    ].filter(Boolean);
    const body = toBase64(text).replace(/.{1,76}/g, '$&\r\n');
    return `${headers.join('\r\n')}\r\n\r\n${body}`;
}

/** Reads SMTP replies (including multi-line ones) from a byte stream. */
export class SmtpReplies {
    constructor(readable) {
        this.reader = readable.getReader();
        this.buffer = '';
    }

    extract() {
        const lines = this.buffer.split('\r\n');
        // The last element is an incomplete line (or empty), so stop before it.
        for (let i = 0; i < lines.length - 1; i++) {
            if (/^\d{3}( |$)/.test(lines[i])) {
                this.buffer = lines.slice(i + 1).join('\r\n');
                const replyLines = lines.slice(0, i + 1);
                return { code: Number(replyLines[0].slice(0, 3)), text: replyLines.join('\n') };
            }
        }
        return null;
    }

    async next() {
        for (;;) {
            const reply = this.extract();
            if (reply) {
                return reply;
            }
            const { value, done } = await this.reader.read();
            if (done) {
                throw new Error('SMTP connection closed unexpectedly');
            }
            this.buffer += decoder.decode(value, { stream: true });
        }
    }
}

export async function sendMail(options) {
    const {
        connect,
        host,
        port = 465,
        user,
        pass,
        from,
        fromName = '',
        to,
        replyTo,
        subject,
        text,
        hostname = 'localhost',
        timeoutMs = 20000,
    } = options;

    assertAddress(from, 'from');
    assertAddress(to, 'recipient');
    if (replyTo) {
        assertAddress(replyTo.email, 'reply-to');
    }
    if (!/^[A-Za-z0-9.-]+$/.test(hostname)) {
        throw new Error('Invalid EHLO hostname');
    }

    const message = buildMessage({ from, fromName, to, replyTo, subject, text });
    const socket = connect({ hostname: host, port }, { secureTransport: 'on', allowHalfOpen: false });
    const writer = socket.writable.getWriter();
    const replies = new SmtpReplies(socket.readable);

    const send = (line) => writer.write(encoder.encode(`${line}\r\n`));
    const expect = async (codes, step) => {
        const reply = await replies.next();
        if (!codes.includes(reply.code)) {
            throw new Error(`SMTP ${step} failed: ${reply.text}`);
        }
    };

    const run = async () => {
        await expect([220], 'greeting');
        await send(`EHLO ${hostname}`);
        await expect([250], 'EHLO');
        await send('AUTH LOGIN');
        await expect([334], 'AUTH');
        await send(toBase64(user));
        await expect([334], 'AUTH username');
        await send(toBase64(pass));
        await expect([235], 'AUTH password');
        await send(`MAIL FROM:<${from}>`);
        await expect([250], 'MAIL FROM');
        await send(`RCPT TO:<${to}>`);
        await expect([250, 251], 'RCPT TO');
        await send('DATA');
        await expect([354], 'DATA');
        await writer.write(encoder.encode(`${dotStuff(message)}.\r\n`));
        await expect([250], 'message delivery');
        delivered = true;

        // The message is accepted. Say goodbye politely, but never let a slow
        // or failed QUIT turn a delivered message into an error.
        let quitTimer;
        const quitWait = new Promise((resolve) => {
            quitTimer = setTimeout(resolve, 1500);
        });
        try {
            await send('QUIT');
            await Promise.race([replies.next().catch(() => {}), quitWait]);
        } catch (ignored) {
            // ignore
        } finally {
            clearTimeout(quitTimer);
        }
    };

    let delivered = false;
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('SMTP timeout')), timeoutMs);
    });
    const running = run();
    running.catch(() => {}); // avoid an unhandled rejection if the timeout wins

    try {
        await Promise.race([running, timeout]);
    } catch (err) {
        if (!delivered) {
            throw err;
        }
        // Delivered already; ignore trouble that happened after acceptance.
    } finally {
        clearTimeout(timer);
        try {
            await Promise.resolve(socket.close()).catch(() => {});
        } catch (ignored) {
            // nothing to clean up
        }
    }
}
