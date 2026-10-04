const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
	'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type ContactMessage = {
	name: string;
	email: string;
	message: string;
};

type EmailStatus = 'sent' | 'failed';
type TurnstileResult = {
	success: boolean;
	hostname?: string;
	action?: string;
};

const jsonResponse = (body: Record<string, string>, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { ...corsHeaders, 'Content-Type': 'application/json' },
	});

const getSupabaseCredentials = () => {
	const url = Deno.env.get('SUPABASE_URL');
	const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

	if (!url || !serviceRoleKey) {
		throw new Error('Supabase server credentials are not configured.');
	}

	return { url: url.replace(/\/$/, ''), serviceRoleKey };
};

const verifyTurnstileToken = async (token: unknown) => {
	const secretKey = Deno.env.get('TURNSTILE_SECRET_KEY');
	if (!secretKey) {
		throw new Error('TURNSTILE_SECRET_KEY is not configured.');
	}

	if (typeof token !== 'string' || token.length === 0 || token.length > 2048) {
		return false;
	}

	const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ secret: secretKey, response: token }),
		signal: AbortSignal.timeout(10000),
	});

	if (!response.ok) {
		throw new Error(`Turnstile verification failed with status ${response.status}.`);
	}

	const result = await response.json() as TurnstileResult;
	const allowedHostnames = (Deno.env.get('TURNSTILE_ALLOWED_HOSTNAMES') ?? '6thlevel.net,www.6thlevel.net')
		.split(',')
		.map((hostname) => hostname.trim())
		.filter(Boolean);

	return result.success === true
		&& result.action === 'contact'
		&& typeof result.hostname === 'string'
		&& allowedHostnames.includes(result.hostname);
};

const saveContactMessage = async (message: ContactMessage) => {
	const { url, serviceRoleKey } = getSupabaseCredentials();
	const response = await fetch(`${url}/rest/v1/contact_messages`, {
		method: 'POST',
		headers: {
			apikey: serviceRoleKey,
			Authorization: `Bearer ${serviceRoleKey}`,
			'Content-Type': 'application/json',
			Prefer: 'return=representation',
		},
		body: JSON.stringify(message),
	});

	if (!response.ok) {
		throw new Error(`Contact message storage failed with status ${response.status}.`);
	}

	const records = await response.json() as Array<{ id: string }>;
	if (!records[0]?.id) {
		throw new Error('Contact message storage returned no record ID.');
	}

	return records[0].id;
};

const updateEmailStatus = async (id: string, emailStatus: EmailStatus) => {
	const { url, serviceRoleKey } = getSupabaseCredentials();
	const response = await fetch(`${url}/rest/v1/contact_messages?id=eq.${encodeURIComponent(id)}`, {
		method: 'PATCH',
		headers: {
			apikey: serviceRoleKey,
			Authorization: `Bearer ${serviceRoleKey}`,
			'Content-Type': 'application/json',
			Prefer: 'return=minimal',
		},
		body: JSON.stringify({
			email_status: emailStatus,
			email_sent_at: emailStatus === 'sent' ? new Date().toISOString() : null,
		}),
	});

	if (!response.ok) {
		throw new Error(`Contact notification status update failed with status ${response.status}.`);
	}
};

const escapeHtml = (value: string) =>
	value.replace(/[&<>"']/g, (character) => ({
		'&': '&amp;',
		'<': '&lt;',
		'>': '&gt;',
		'"': '&quot;',
		"'": '&#39;',
	}[character] ?? character));

const getContactMessage = (value: unknown): ContactMessage | null => {
	if (!value || typeof value !== 'object') return null;

	const message = value as Record<string, unknown>;
	const name = typeof message.name === 'string' ? message.name.trim() : '';
	const email = typeof message.email === 'string' ? message.email.trim() : '';
	const content = typeof message.message === 'string' ? message.message.trim() : '';

	if (!name || !content || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
		return null;
	}

	if (name.length > 120 || email.length > 320 || content.length > 5000) {
		return null;
	}

	return { name, email, message: content };
};

const sendMessageWithResend = async (message: ContactMessage) => {
	const apiKey = Deno.env.get('RESEND_API_KEY');
	const fromAddress = Deno.env.get('RESEND_FROM_EMAIL') ?? 'hutton@6thlevel.net';
	const toAddress = Deno.env.get('CONTACT_TO_EMAIL') ?? 'hutton@6thlevel.net';

	if (!apiKey) {
		throw new Error('RESEND_API_KEY is not configured.');
	}

	const response = await fetch('https://api.resend.com/emails', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			from: fromAddress,
			to: [toAddress],
			reply_to: message.email,
			subject: `Project inquiry from ${message.name}`,
			html: [
				`<p><strong>Name:</strong> ${escapeHtml(message.name)}</p>`,
				`<p><strong>Email:</strong> ${escapeHtml(message.email)}</p>`,
				`<p>${escapeHtml(message.message).replace(/\n/g, '<br>')}</p>`,
			].join(''),
		}),
	});

	if (!response.ok) {
		const detail = await response.text();
		throw new Error(`Resend delivery failed: ${detail}`);
	}
};

Deno.serve(async (request) => {
	if (request.method === 'OPTIONS') {
		return new Response('ok', { headers: corsHeaders });
	}

	if (request.method !== 'POST') {
		return jsonResponse({ error: 'Method not allowed.' }, 405);
	}

	try {
		const body = await request.json();
		if (body && typeof body === 'object' && 'company_website' in body && body.company_website) {
			return jsonResponse({ message: 'Message received.' });
		}

		const message = getContactMessage(body);
		if (!message) {
			return jsonResponse({ error: 'Please provide a valid name, email, and message.' }, 400);
		}

		const turnstileToken = body && typeof body === 'object'
			? (body as Record<string, unknown>)['cf-turnstile-response']
			: null;
		let turnstileVerified: boolean;
		try {
			turnstileVerified = await verifyTurnstileToken(turnstileToken);
		} catch (error) {
			console.error('Contact form spam verification is unavailable.', error);
			return jsonResponse({ error: 'Spam protection is temporarily unavailable. Please try again later.' }, 503);
		}

		if (!turnstileVerified) {
			return jsonResponse({ error: 'Please complete the spam check and try again.' }, 400);
		}

		const messageId = await saveContactMessage(message);
		let emailSent = false;

		try {
			await sendMessageWithResend(message);
			emailSent = true;
		} catch (error) {
			console.error('Contact email delivery failed.', error);
		}

		try {
			await updateEmailStatus(messageId, emailSent ? 'sent' : 'failed');
		} catch (error) {
			console.error('Unable to update contact email status.', error);
		}

		if (!emailSent) {
			return jsonResponse({ message: 'Your message was saved, but the email notification could not be sent.' }, 202);
		}

		return jsonResponse({ message: 'Message received and emailed. Thank you.' });
	} catch (error) {
		console.error('Unable to save contact message.', error);
		return jsonResponse({ error: 'Unable to save your message right now. Please try again.' }, 503);
	}
});
