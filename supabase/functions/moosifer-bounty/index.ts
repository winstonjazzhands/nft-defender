import { createClient } from 'jsr:@supabase/supabase-js@2';
import { loadValidWalletSession, normalizeAddress } from '../_shared/wallet-session.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-session-token',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function createAdmin() {
  const url = Deno.env.get('SUPABASE_URL') || '';
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!url || !key) throw new Error('Supabase service role is not configured.');
  return createClient(url, key, { auth: { persistSession: false } });
}

function adminWallets() {
  const raw = [
    Deno.env.get('DFK_REWARD_ADMIN_WALLET') || '',
    Deno.env.get('DFK_AVAX_TREASURY_ADDRESS') || '',
    Deno.env.get('DFK_PRIVATE_ADMIN_WALLETS') || '',
  ].join(',');
  return raw.split(',').map((value) => normalizeAddress(value)).filter(Boolean);
}

function isAdminWallet(walletAddress: string) {
  const wallet = normalizeAddress(walletAddress);
  return !!wallet && adminWallets().includes(wallet);
}

async function ensurePlayer(admin: ReturnType<typeof createAdmin>, walletAddress: string) {
  const wallet = normalizeAddress(walletAddress);
  if (!wallet) return;
  await admin
    .from('players')
    .upsert({ wallet_address: wallet }, { onConflict: 'wallet_address', ignoreDuplicates: true });
}

async function ensureState(admin: ReturnType<typeof createAdmin>) {
  await admin
    .from('moosifer_bounty_state')
    .upsert({ id: true, reward_enabled: true, reward_amount: 500, reward_currency: 'JEWEL' }, { onConflict: 'id', ignoreDuplicates: true });
}

function getMoosiferNotifyWebhookUrl() {
  return Deno.env.get('DFK_MOOSIFER_NOTIFY_WEBHOOK_URL')
    || Deno.env.get('MOOSIFER_NOTIFY_WEBHOOK_URL')
    || '';
}

function formatAttemptLine(payload: Record<string, unknown>) {
  const wallet = normalizeAddress(String(payload.walletAddress || payload.wallet_address || '')) || 'unknown wallet';
  const runId = String(payload.runId || payload.clientRunId || '').trim() || 'no run id';
  const waveReached = Math.max(0, Math.floor(Number(payload.waveReached || 0) || 0));
  const difficulty = Math.max(0, Math.floor(Number(payload.moosiferDifficulty || payload.difficulty || 0) || 0));
  const hpRemaining = Math.max(0, Number(payload.moosiferHpRemaining || payload.moosiferHP || 0) || 0);
  const maxHp = Math.max(0, Number(payload.moosiferMaxHp || 0) || 0);
  const portalHp = Math.max(0, Number(payload.portalHpRemaining || 0) || 0);
  const portalMaxHp = Math.max(0, Number(payload.portalMaxHp || 0) || 0);
  return [
    `Wallet: ${wallet}`,
    `Run: ${runId}`,
    waveReached ? `Wave: ${waveReached}` : '',
    difficulty ? `Moosifer D${difficulty}` : '',
    maxHp ? `Mo HP: ${Math.round(hpRemaining).toLocaleString()} / ${Math.round(maxHp).toLocaleString()}` : '',
    portalMaxHp ? `Portal HP: ${Math.round(portalHp).toLocaleString()} / ${Math.round(portalMaxHp).toLocaleString()}` : '',
  ].filter(Boolean).join('\n');
}

async function notifyMoosiferDefeat(payload: Record<string, unknown>) {
  const webhookUrl = getMoosiferNotifyWebhookUrl();
  if (!webhookUrl) return;
  const text = `Moosifer defeated!\n${formatAttemptLine(payload)}`;
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text, text }),
    });
  } catch (error) {
    console.warn('Moosifer notification failed:', error);
  }
}

function buildAttemptRow(body: Record<string, unknown>, walletAddress: string, outcome: string) {
  const runId = String(body.runId || body.clientRunId || '').trim();
  const waveReached = Math.max(0, Math.floor(Number(body.waveReached || 0) || 0));
  const moosiferDifficulty = Math.max(0, Math.floor(Number(body.moosiferDifficulty || body.difficulty || 0) || 0));
  const moosiferHpRemaining = Math.max(0, Number(body.moosiferHpRemaining || body.moosiferHP || 0) || 0);
  const moosiferMaxHp = Math.max(0, Number(body.moosiferMaxHp || 0) || 0);
  const portalHpRemaining = Math.max(0, Number(body.portalHpRemaining || 0) || 0);
  const portalMaxHp = Math.max(0, Number(body.portalMaxHp || 0) || 0);
  const moosiferPhase = String(body.moosiferPhase || '').trim();
  const nowIso = new Date().toISOString();
  return {
    run_id: runId || null,
    wallet_address: walletAddress || null,
    outcome,
    completed_at: outcome === 'started' ? null : nowIso,
    wave_reached: waveReached || null,
    moosifer_difficulty: moosiferDifficulty || null,
    moosifer_hp_remaining: moosiferHpRemaining || null,
    moosifer_max_hp: moosiferMaxHp || null,
    portal_hp_remaining: portalHpRemaining || null,
    portal_max_hp: portalMaxHp || null,
    moosifer_phase: moosiferPhase || null,
    source: 'client',
    details: {
      liveWaveCount: Number(body.liveWaveCount || 0) || 0,
      heroesAlive: Number(body.heroesAlive || 0) || 0,
      moosiferReachedVoid: !!body.moosiferReachedVoid,
      result: String(body.result || outcome),
    },
  };
}

async function upsertMoosiferAttempt(admin: ReturnType<typeof createAdmin>, body: Record<string, unknown>, walletAddress: string, outcome: string) {
  const row = buildAttemptRow(body, walletAddress, outcome);
  const runId = String(row.run_id || '').trim();
  if (walletAddress) await ensurePlayer(admin, walletAddress);

  if (runId) {
    const { data: existing, error: existingError } = await admin
      .from('moosifer_attempts')
      .select('id, outcome')
      .eq('run_id', runId)
      .maybeSingle();
    if (existingError) throw existingError;
    if (existing && outcome === 'started' && existing.outcome !== 'started') {
      return { inserted: false, previousOutcome: existing.outcome || null };
    }
    const { error } = await admin
      .from('moosifer_attempts')
      .upsert(row, { onConflict: 'run_id' });
    if (error) throw error;
    return { inserted: !existing, previousOutcome: existing?.outcome || null };
  }

  const { error } = await admin
    .from('moosifer_attempts')
    .insert(row);
  if (error) throw error;
  return { inserted: true, previousOutcome: null };
}

async function loadStatus(admin: ReturnType<typeof createAdmin>, walletAddress = '') {
  await ensureState(admin);
  const { data: stateRow, error: stateError } = await admin
    .from('moosifer_bounty_state')
    .select('reward_enabled, reward_amount, reward_currency, claimed_by_wallet, claimed_run_id, claimed_at')
    .eq('id', true)
    .maybeSingle();
  if (stateError) throw stateError;

  const { count, error: countError } = await admin
    .from('moosifer_defeats')
    .select('id', { count: 'exact', head: true });
  if (countError) throw countError;

  const rewardEnabled = !!stateRow?.reward_enabled;
  const claimed = !!stateRow?.claimed_at || !!stateRow?.claimed_by_wallet;
  const wallet = normalizeAddress(walletAddress);
  let playerDefeatedMoosifer = false;
  if (wallet) {
    const { data: defeatRow, error: defeatError } = await admin
      .from('moosifer_defeats')
      .select('id')
      .eq('wallet_address', wallet)
      .limit(1)
      .maybeSingle();
    if (defeatError) throw defeatError;
    playerDefeatedMoosifer = !!defeatRow;
  }

  return {
    ok: true,
    defeatedCount: Number(count || 0) || 0,
    rewardEnabled,
    rewardAmount: Number(stateRow?.reward_amount || 500) || 500,
    rewardCurrency: String(stateRow?.reward_currency || 'JEWEL'),
    claimed,
    claimedAt: stateRow?.claimed_at || null,
    alreadyClaimedByAnotherPlayer: claimed && (!wallet || normalizeAddress(String(stateRow?.claimed_by_wallet || '')) !== wallet),
    playerDefeatedMoosifer,
    claimAvailable: rewardEnabled && !claimed && playerDefeatedMoosifer,
  };
}

async function readBody(req: Request) {
  if (req.method === 'GET') return {};
  return await req.json().catch(() => ({}));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { status: 200, headers: corsHeaders });
  try {
    const admin = createAdmin();
    const body = await readBody(req) as Record<string, unknown>;
    const action = String(body.action || (req.method === 'GET' ? 'status' : '') || '').trim().toLowerCase();
    const requestedWallet = normalizeAddress(String(body.walletAddress || body.wallet_address || req.headers.get('x-wallet-address') || ''));

    if (req.method === 'GET' || action === 'status' || !action) {
      return json(await loadStatus(admin, requestedWallet));
    }

    if (['attempt_started', 'attempt_failed', 'attempt_abandoned', 'attempt_disconnected'].includes(action)) {
      const sessionResult = await loadValidWalletSession(admin, req, corsHeaders, { validateContext: true });
      let walletAddress = requestedWallet;
      if (!sessionResult.response && sessionResult.session?.wallet_address) {
        walletAddress = normalizeAddress(sessionResult.session.wallet_address);
      }
      const outcome = action === 'attempt_started'
        ? 'started'
        : (action === 'attempt_failed' ? 'failed' : action.replace('attempt_', ''));
      await upsertMoosiferAttempt(admin, body, walletAddress, outcome);
      return json({ ...(await loadStatus(admin, walletAddress)), attemptTracked: true, outcome });
    }

    if (action === 'defeated') {
      const runId = String(body.runId || body.clientRunId || '').trim();
      const waveReached = Math.max(0, Math.floor(Number(body.waveReached || 50) || 50));
      const sessionResult = await loadValidWalletSession(admin, req, corsHeaders, { validateContext: true });
      let walletAddress = requestedWallet;
      if (!sessionResult.response && sessionResult.session?.wallet_address) {
        walletAddress = normalizeAddress(sessionResult.session.wallet_address);
      }
      if (walletAddress) await ensurePlayer(admin, walletAddress);
      const attemptResult = await upsertMoosiferAttempt(admin, body, walletAddress, 'defeated');
      if (runId) {
        await admin
          .from('moosifer_defeats')
          .upsert({ run_id: runId, wallet_address: walletAddress || null, wave_reached: waveReached, source: 'client' }, { onConflict: 'run_id', ignoreDuplicates: true });
      } else {
        await admin
          .from('moosifer_defeats')
          .insert({ wallet_address: walletAddress || null, wave_reached: waveReached, source: 'client' });
      }
      if (attemptResult.previousOutcome !== 'defeated') {
        await notifyMoosiferDefeat({ ...body, walletAddress });
      }
      return json(await loadStatus(admin, walletAddress));
    }

    if (action === 'admin_update') {
      const sessionResult = await loadValidWalletSession(admin, req, corsHeaders, { validateContext: true });
      if (sessionResult.response) return sessionResult.response;
      const sessionWallet = normalizeAddress(sessionResult.session?.wallet_address || '');
      if (!isAdminWallet(sessionWallet)) return json({ error: 'Admin wallet required.' }, 403);
      await ensureState(admin);
      const { error } = await admin
        .from('moosifer_bounty_state')
        .update({ reward_enabled: !!body.rewardEnabled })
        .eq('id', true);
      if (error) throw error;
      return json(await loadStatus(admin, requestedWallet || sessionWallet));
    }

    if (action === 'admin_attempts') {
      const sessionResult = await loadValidWalletSession(admin, req, corsHeaders, { validateContext: true });
      if (sessionResult.response) return sessionResult.response;
      const sessionWallet = normalizeAddress(sessionResult.session?.wallet_address || '');
      if (!isAdminWallet(sessionWallet)) return json({ error: 'Admin wallet required.' }, 403);
      const limit = Math.max(1, Math.min(100, Math.floor(Number(body.limit || 50) || 50)));
      const { data, error } = await admin
        .from('moosifer_attempts')
        .select('run_id, wallet_address, started_at, completed_at, outcome, wave_reached, moosifer_difficulty, moosifer_hp_remaining, moosifer_max_hp, portal_hp_remaining, portal_max_hp, moosifer_phase, details')
        .order('started_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return json({ ok: true, attempts: data || [] });
    }

    if (action === 'claim') {
      const sessionResult = await loadValidWalletSession(admin, req, corsHeaders, { validateContext: true });
      if (sessionResult.response) return sessionResult.response;
      const walletAddress = normalizeAddress(sessionResult.session?.wallet_address || '');
      if (!walletAddress || (requestedWallet && requestedWallet !== walletAddress)) return json({ error: 'Wallet mismatch.' }, 401);
      const runId = String(body.runId || body.clientRunId || '').trim();
      await ensurePlayer(admin, walletAddress);

      let defeatQuery = admin
        .from('moosifer_defeats')
        .select('id')
        .eq('wallet_address', walletAddress)
        .limit(1);
      if (runId) defeatQuery = defeatQuery.or(`run_id.eq.${runId},wallet_address.eq.${walletAddress}`);
      const { data: defeatRow, error: defeatError } = await defeatQuery.maybeSingle();
      if (defeatError) throw defeatError;
      if (!defeatRow) return json({ error: 'Moosifer defeat record required before claiming.' }, 403);

      const { data: claimedState, error: claimError } = await admin
        .from('moosifer_bounty_state')
        .update({ claimed_by_wallet: walletAddress, claimed_run_id: runId || null, claimed_at: new Date().toISOString() })
        .eq('id', true)
        .eq('reward_enabled', true)
        .is('claimed_at', null)
        .select('reward_amount, reward_currency, claimed_at')
        .maybeSingle();
      if (claimError) throw claimError;
      if (!claimedState) return json({ ...(await loadStatus(admin, walletAddress)), message: 'Already claimed by another player.' }, 409);

      const amount = Number(claimedState.reward_amount || 500) || 500;
      const currency = String(claimedState.reward_currency || 'JEWEL').toUpperCase();
      const requestKey = 'moosifer:first-defeat';
      await admin
        .from('reward_claim_requests')
        .upsert({
          request_key: requestKey,
          wallet_address: walletAddress,
          claim_type: 'moosifer_first_defeat',
          status: 'pending',
          amount_text: `${amount} ${currency}`,
          amount_value: amount,
          reward_currency: currency,
          reason_text: 'First player to defeat Moosifer.',
          source_ref: `moosifer:first-defeat${runId ? `:${runId}` : ''}`,
          claim_day: new Date().toISOString().slice(0, 10),
        }, { onConflict: 'request_key', ignoreDuplicates: true });
      return json({ ...(await loadStatus(admin, walletAddress)), message: `${amount} ${currency} claim recorded.` });
    }

    return json({ error: 'Unsupported Moosifer bounty action.' }, 400);
  } catch (error) {
    console.error('moosifer-bounty failure:', error);
    return json({ error: String((error as { message?: unknown })?.message || error || 'Moosifer bounty failed.') }, 500);
  }
});
