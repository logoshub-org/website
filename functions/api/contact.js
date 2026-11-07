// Cloudflare Pages Function: POST /api/contact
import { connect } from 'cloudflare:sockets';
import { handleContact } from '../_lib/contact.js';

export const onRequestPost = ({ request, env }) => handleContact(request, env, connect);

export const onRequest = () =>
    new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
