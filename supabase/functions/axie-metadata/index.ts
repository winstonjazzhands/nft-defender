const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Cache-Control': 'public, max-age=3600',
};

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function normalizeMetadataUrl(value: unknown) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return '';
    const host = url.hostname.toLowerCase();
    const allowedHosts = new Set([
      'metadata.axieinfinity.com',
      'axiecdn.axieinfinity.com',
    ]);
    if (!allowedHosts.has(host)) return '';
    return url.toString();
  } catch (_error) {
    return '';
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { status: 200, headers: corsHeaders });
  try {
    const requestUrl = new URL(req.url);
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    const tokenId = String(body.tokenId || requestUrl.searchParams.get('tokenId') || '').trim();
    const uri = normalizeMetadataUrl(body.uri || requestUrl.searchParams.get('uri') || (tokenId ? `https://metadata.axieinfinity.com/axie/${tokenId}` : ''));
    if (!uri) return json({ error: 'Valid Axie metadata URI is required.' }, 400);

    const response = await fetch(uri, {
      headers: { accept: 'application/json' },
    });
    const text = await response.text();
    if (!response.ok) {
      return json({ error: `Axie metadata request failed: ${response.status}` }, response.status >= 500 ? 502 : response.status);
    }

    const metadata = JSON.parse(text);
    return json({ ok: true, metadata });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Failed to load Axie metadata.' }, 500);
  }
});
