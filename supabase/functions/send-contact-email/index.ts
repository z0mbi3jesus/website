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

const getZohoAccessToken = async () => {
	const params = new URLSearchParams({
		refresh_token: Deno.env.get('ZOHO_REFRESH_TOKEN') ?? '',
		client_id: Deno.env.get('ZOHO_CLIENT_ID') ?? '',
		client_secret: Deno.env.get('ZOHO_CLIENT_SECRET') ?? '',
		grant_type: 'refresh_token',
	});

	const response = await fetch(`https://accounts.zoho.com/oauth/v2/token?${params}`, {
		method: 'POST',
	});

	if (!response.ok) {
		throw new Error('Zoho token refresh failed.');
	}

	const result = await response.json();
	if (typeof result.access_token !== 'string') {
		throw new Error('Zoho token response did not include an access token.');
	}

	return result.access_token;
};

const sendZohoMessage = async (message: ContactMessage) => {
	const accountId = Deno.env.get('ZOHO_ACCOUNT_ID');
	const fromAddress = Deno.env.get('ZOHO_FROM_EMAIL') ?? 'hutton@6thlevel.net';
	const accessToken = await getZohoAccessToken();

	if (!accountId) {
		throw new Error('ZOHO_ACCOUNT_ID is not configured.');
	}

	const response = await fetch(`https://mail.zoho.com/api/accounts/${accountId}/messages`, {
		method: 'POST',
		headers: {
			Authorization: `Zoho-oauthtoken ${accessToken}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			fromAddress,
			toAddress: fromAddress,
			subject: `Project inquiry from ${message.name}`,
			contentType: 'html',
			content: [
				`<p><strong>Name:</strong> ${escapeHtml(message.name)}</p>`,
				`<p><strong>Email:</strong> ${escapeHtml(message.email)}</p>`,
				`<p>${escapeHtml(message.message).replace(/\n/g, '<br>')}</p>`,
			].join(''),
		}),
	});

	if (!response.ok) {
		throw new Error('Zoho message delivery failed.');
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

		await sendZohoMessage(message);
		return jsonResponse({ message: 'Message sent.' });
	} catch (error) {
		console.error(error);
		return jsonResponse({ error: 'Unable to deliver the message.' }, 502);
	}
});
