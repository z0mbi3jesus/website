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

const jsonResponse = (body: Record<string, string>, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { ...corsHeaders, 'Content-Type': 'application/json' },
	});

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
		const message = getContactMessage(await request.json());
		if (!message) {
			return jsonResponse({ error: 'Please provide a valid name, email, and message.' }, 400);
		}

		await sendMessageWithResend(message);
		return jsonResponse({ message: 'Message sent.' });
	} catch (error) {
		console.error(error);
		return jsonResponse({ error: 'Unable to deliver the message.' }, 502);
	}
});
