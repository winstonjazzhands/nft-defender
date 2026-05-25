import { createClient } from 'jsr:@supabase/supabase-js@2';
import { loadValidWalletSession, normalizeAddress } from '../_shared/wallet-session.ts';
import { isAutoRewardPayoutConfigured, tryAutoPayRewardClaim } from '../_shared/reward-payout.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-session-token',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}


function normalizeOrigin(value: string | null | undefined) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try { return new URL(raw).origin.toLowerCase(); } catch { return ''; }
}

function requestOrigin(req: Request) {
  return normalizeOrigin(req.headers.get('origin') || req.headers.get('referer') || '');
}

async function sha256Hex(value: string) {
  const data = new TextEncoder().encode(String(value || ''));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function validateSessionContext(req: Request, session: Record<string, unknown>) {
  const expectedOrigin = normalizeOrigin(String(session.session_origin || ''));
  if (expectedOrigin) {
    const actualOrigin = requestOrigin(req);
    if (!actualOrigin || actualOrigin !== expectedOrigin) return json({ error: 'Session origin mismatch.' }, 401);
  }
  const expectedUserAgentHash = String(session.user_agent_hash || '').trim();
  if (expectedUserAgentHash) {
    const actualUserAgent = String(req.headers.get('user-agent') || '').trim();
    if (!actualUserAgent) return json({ error: 'User agent missing for session.' }, 401);
    const actualHash = await sha256Hex(actualUserAgent);
    if (actualHash !== expectedUserAgentHash) return json({ error: 'Session device mismatch.' }, 401);
  }
  return null;
}

function createAdmin() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

function parseAmountValue(text: string) {
  const match = String(text || '').match(/([\d.]+)/);
  const value = Number(match?.[1] || 0);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function formatAmountText(amountValue: number | null, rewardCurrency: string | null, fallback: string) {
  if (!(Number(amountValue) > 0) || !rewardCurrency) return String(fallback || '').trim();
  const normalizedAmount = String(amountValue)
    .replace(/(\.\d*?[1-9])0+$/g, '$1')
    .replace(/\.0+$/g, '');
  return `${normalizedAmount} ${rewardCurrency}`.trim();
}

function inferRewardCurrency(rewardText: string, requestedRewardCurrency: string) {
  const requested = String(requestedRewardCurrency || '').trim().toUpperCase();
  if (['JEWEL', 'AVAX', 'HONK', 'RON'].includes(requested)) return requested;
  const text = String(rewardText || '').trim();
  if (/\bron\b/i.test(text)) return 'RON';
  if (/\bhonk\b/i.test(text)) return 'HONK';
  if (/\bavax\b/i.test(text)) return 'AVAX';
  if (/\bjewel\b/i.test(text)) return 'JEWEL';
  return null;
}

const PRIVATE_DAILY_QUEST_TEST_RESET_WALLET = '0x971bdacd04ef40141ddb6ba175d4f76665103c81';
const DEFAULT_AUTO_DAILY_REWARD_WALLETS = [
  PRIVATE_DAILY_QUEST_TEST_RESET_WALLET,
  '0xba42e89b2f69c68e79898ba73d9a4eb13d25c70e',
];

function getAutoDailyRewardWallets() {
  const envWallets = String(Deno.env.get('DFK_AUTO_DAILY_REWARD_WALLETS') || Deno.env.get('DFK_PRIVATE_ADMIN_WALLETS') || '')
    .split(',')
    .map((value) => normalizeAddress(value))
    .filter(Boolean);
  return Array.from(new Set([...DEFAULT_AUTO_DAILY_REWARD_WALLETS, ...envWallets]));
}

async function findQualifyingRunForClaim(admin: ReturnType<typeof createAdmin>, walletAddress: string, dayStartIso: string) {
  const attempts = [
    {
      label: 'completed_at',
      build: () => admin
        .from('runs')
        .select('id, wave_reached, completed_at, created_at, run_started_at')
        .eq('wallet_address', walletAddress)
        .gte('completed_at', dayStartIso)
        .gt('wave_reached', 0)
        .order('completed_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    },
    {
      label: 'created_at',
      build: () => admin
        .from('runs')
        .select('id, wave_reached, completed_at, created_at, run_started_at')
        .eq('wallet_address', walletAddress)
        .gte('created_at', dayStartIso)
        .gt('wave_reached', 0)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    },
    {
      label: 'run_started_at',
      build: () => admin
        .from('runs')
        .select('id, wave_reached, completed_at, created_at, run_started_at')
        .eq('wallet_address', walletAddress)
        .gte('run_started_at', dayStartIso)
        .gt('wave_reached', 0)
        .order('run_started_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    },
  ];

  const diagnostics: Record<string, string> = {};
  for (const attempt of attempts) {
    const { data, error } = await attempt.build();
    if (error) {
      diagnostics[attempt.label] = error.message || 'query_failed';
      continue;
    }
    if (data?.id) {
      return { run: data, matchedOn: attempt.label, diagnostics };
    }
  }

  const latestAttempts = [
    {
      label: 'latest_completed_at',
      build: () => admin
        .from('runs')
        .select('id, wave_reached, completed_at, created_at, run_started_at')
        .eq('wallet_address', walletAddress)
        .order('completed_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    },
    {
      label: 'latest_created_at',
      build: () => admin
        .from('runs')
        .select('id, wave_reached, completed_at, created_at, run_started_at')
        .eq('wallet_address', walletAddress)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    },
  ];

  for (const attempt of latestAttempts) {
    const { data, error } = await attempt.build();
    if (error) {
      diagnostics[attempt.label] = error.message || 'query_failed';
      continue;
    }
    if (data?.id) {
      return { run: null, matchedOn: '', diagnostics, latestRun: data, latestRunSource: attempt.label };
    }
  }

  return { run: null, matchedOn: '', diagnostics, latestRun: null, latestRunSource: '' };
}


async function getWhitelistDecision(
  admin: ReturnType<typeof createAdmin>,
  walletAddress: string,
  claimType: 'daily_quest' | 'bounty',
  amountValue: number | null,
  claimDay: string,
  options: { bypassDailyCap?: boolean } = {},
) {
  const { data: rule, error: ruleError } = await admin
    .from('reward_claim_whitelist')
    .select('wallet_address, is_active, auto_daily, auto_bounty, max_claim_amount, daily_cap, notes')
    .eq('wallet_address', walletAddress)
    .maybeSingle();
  if (ruleError) throw ruleError;
  const isDefaultAutoDailyWallet = claimType === 'daily_quest' && getAutoDailyRewardWallets().includes(walletAddress);
  if (!rule && !isDefaultAutoDailyWallet) return { autoApprove: false, note: '', reason: 'No whitelist entry found for this wallet.' };
  if (!rule && isDefaultAutoDailyWallet) {
    return {
      autoApprove: true,
      note: 'Auto-approved by default daily reward wallet rule.',
      reason: 'Default daily reward wallet auto-approval allowed this claim.',
    };
  }
  if (!rule.is_active) return { autoApprove: false, note: String(rule.notes || '').trim() || '', reason: 'Whitelist entry is inactive.' };

  const allowsType = claimType === 'daily_quest' ? !!rule.auto_daily : !!rule.auto_bounty;
  if (!allowsType && !isDefaultAutoDailyWallet) {
    return {
      autoApprove: false,
      note: String(rule.notes || '').trim() || '',
      reason: claimType === 'daily_quest'
        ? 'Whitelist entry does not allow auto-approval for daily rewards.'
        : 'Whitelist entry does not allow auto-approval for bounties.',
    };
  }

  const numericAmount = Number(amountValue || 0) || 0;
  const maxClaimAmount = rule.max_claim_amount == null ? null : Number(rule.max_claim_amount);
  if (maxClaimAmount != null && numericAmount > maxClaimAmount) {
    return { autoApprove: false, note: 'Whitelist max-claim guard prevented auto-approval.', reason: 'Claim amount is above whitelist max_claim_amount.' };
  }

  const dailyCap = rule.daily_cap == null ? null : Number(rule.daily_cap);
  if (dailyCap != null && !options.bypassDailyCap) {
    const { data: sameDayRows, error: sameDayError } = await admin
      .from('reward_claim_requests')
      .select('amount_value, status')
      .eq('wallet_address', walletAddress)
      .eq('claim_day', claimDay)
      .in('status', ['approved', 'paid'])
      .neq('claim_type', 'manual_adjustment');
    if (sameDayError) throw sameDayError;
    const usedToday = (sameDayRows || []).reduce((sum, row) => sum + (Number(row.amount_value || 0) || 0), 0);
    if ((usedToday + numericAmount) > dailyCap) {
      return { autoApprove: false, note: 'Whitelist daily cap prevented auto-approval.', reason: 'Claim would exceed whitelist daily_cap.' };
    }
  }

  const noteParts = ['Auto-approved by whitelist rule.'];
  if (!allowsType && isDefaultAutoDailyWallet) noteParts.push('Default daily reward wallet override enabled auto_daily.');
  const notes = String(rule.notes || '').trim();
  if (notes) noteParts.push(notes);
  return { autoApprove: true, note: noteParts.join(' '), reason: 'Whitelist auto-approval allowed this claim.' };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { status: 200, headers: corsHeaders });
  try {
    const body = await req.clone().json().catch(() => ({}));
    const requestHeaders = new Headers(req.headers);
    const bodySessionToken = String((body as Record<string, unknown>)?.sessionToken || '').trim();
    if (bodySessionToken && !String(requestHeaders.get('x-session-token') || '').trim()) {
      requestHeaders.set('x-session-token', bodySessionToken);
    }

    const admin = createAdmin();
    const sessionReq = new Request(req.url, { method: req.method, headers: requestHeaders });
    const sessionResult = await loadValidWalletSession(admin, sessionReq, corsHeaders, { validateContext: true });
    if (sessionResult.response) return sessionResult.response;
    const session = sessionResult.session;
    if (!session) return json({ error: 'Session not found.', code: 'session_not_found' }, 401);

    const walletAddress = normalizeAddress(body.walletAddress as string);
    if (!walletAddress || walletAddress !== normalizeAddress(session.wallet_address)) return json({ error: 'Wallet mismatch.', code: 'wallet_mismatch' }, 401);

    const claimType = String(body.claimType || '').trim().toLowerCase();
    if (claimType !== 'daily_quest') return json({ error: 'Unsupported reward claim type.' }, 400);

    const questId = String(body.questId || '').trim().toLowerCase();
    const questName = String(body.questName || '').trim() || 'Daily quest';
    const rewardText = String(body.rewardText || '').trim() || '2 Jewel';
    const playerName = String(body.playerName || '').trim() || walletAddress;
    const requestedRewardCurrency = String(body.rewardCurrency || '').trim().toUpperCase();
    const requestedRewardAmountValue = Number(body.rewardAmountValue);
    const requestedTestResetCycle = Math.max(0, Math.floor(Number(body.testResetCycle) || 0));
    if (!questId) return json({ error: 'Quest ID is required.' }, 400);

    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const claimDay = dayStart.toISOString().slice(0, 10);

    const qualifyingRunLookup = await findQualifyingRunForClaim(admin, walletAddress, dayStart.toISOString());
    const qualifyingRun = qualifyingRunLookup.run;
    if (!qualifyingRun?.id) {
      const latestTrackedAt = String(
        qualifyingRunLookup.latestRun?.completed_at
          || qualifyingRunLookup.latestRun?.created_at
          || qualifyingRunLookup.latestRun?.run_started_at
          || ''
      ).trim() || null;
      const latestWaveReached = Number(qualifyingRunLookup.latestRun?.wave_reached || 0) || 0;
      return json({
        error: 'Complete at least one tracked run after 00:00 UTC before claiming a daily reward.',
        code: 'no_qualifying_run_today',
        dayStartUtc: dayStart.toISOString(),
        latestTrackedRunAt: latestTrackedAt,
        latestTrackedRunWave: latestWaveReached,
        diagnostics: qualifyingRunLookup.diagnostics,
        hint: latestTrackedAt
          ? `Latest tracked run was ${latestTrackedAt}. Reward claims unlock after a tracked run in the current UTC day.`
          : 'No qualifying tracked run was found in the current UTC day.',
      }, 409);
    }

    const amountValue = Number.isFinite(requestedRewardAmountValue) && requestedRewardAmountValue > 0
      ? requestedRewardAmountValue
      : parseAmountValue(rewardText);
    const rewardCurrency = inferRewardCurrency(rewardText, requestedRewardCurrency);
    const canonicalAmountText = formatAmountText(amountValue, rewardCurrency, rewardText);
    const authorizedTestResetCycle = walletAddress === PRIVATE_DAILY_QUEST_TEST_RESET_WALLET ? requestedTestResetCycle : 0;
    const whitelistDecision = await getWhitelistDecision(admin, walletAddress, 'daily_quest', amountValue, claimDay, {
      bypassDailyCap: authorizedTestResetCycle > 0,
    });

    const requestKey = `daily_quest:${walletAddress}:${claimDay}:${questId}${authorizedTestResetCycle > 0 ? `:testcycle_${authorizedTestResetCycle}` : ''}`;
    const { data: existingClaim, error: existingError } = await admin
      .from('reward_claim_requests')
      .select('id, status, tx_hash, paid_at, reward_currency, amount_value, amount_text, wallet_address, admin_note, approved_at, resolved_at, resolved_by_wallet, failure_reason')
      .eq('request_key', requestKey)
      .maybeSingle();
    if (existingError) throw existingError;
    if (existingClaim?.id) {
      let existingStatus = existingClaim.status || 'pending';
      let existingTxHash = existingClaim.tx_hash || null;
      let existingMessage = (existingClaim.status === 'paid' || existingClaim.tx_hash)
        ? `${questName} was already paid from treasury.`
        : `${questName} was already submitted earlier today.`;
      let existingPayoutAttempted = false;
      let existingPayoutAttemptId: string | null = null;
      let existingPayoutFailureReason = String(existingClaim.failure_reason || '').trim() || null;

      // If a whitelisted claim was created/approved but the client never received a payout
      // tx (or an older build failed before paying), retry the auto-payout on repeat calls.
      // This lets the frontend polling path recover and show the tx-backed “hell yeah” screen.
      const existingClaimApproved = String(existingClaim.status || '').trim().toLowerCase() === 'approved'
        || !!String(existingClaim.approved_at || '').trim();
      let claimForPayout = existingClaim;
      const existingClaimPending = String(existingClaim.status || '').trim().toLowerCase() === 'pending';
      if (!existingClaimApproved && existingClaimPending && whitelistDecision.autoApprove) {
        const nowIso = new Date().toISOString();
        const upgradedNote = [existingClaim.admin_note || null, whitelistDecision.note || null, 'Pending claim upgraded to auto-approved on retry.'].filter(Boolean).join(' ') || null;
        const { data: upgradedClaim, error: upgradeError } = await admin
          .from('reward_claim_requests')
          .update({
            status: 'approved',
            approved_at: existingClaim.approved_at || nowIso,
            resolved_at: existingClaim.resolved_at || nowIso,
            resolved_by_wallet: existingClaim.resolved_by_wallet || 'whitelist:auto',
            reward_currency: existingClaim.reward_currency || rewardCurrency,
            amount_value: existingClaim.amount_value ?? amountValue,
            amount_text: existingClaim.amount_text || canonicalAmountText,
            admin_note: upgradedNote,
            failure_reason: null,
          })
          .eq('id', existingClaim.id)
          .select('id, status, tx_hash, paid_at, reward_currency, amount_value, amount_text, wallet_address, admin_note, approved_at, resolved_at, resolved_by_wallet, failure_reason')
          .single();
        if (upgradeError) throw upgradeError;
        if (upgradedClaim?.id) {
          claimForPayout = upgradedClaim;
          existingStatus = 'approved';
          existingMessage = `${questName} claim auto-approved for this whitelisted wallet. Retrying treasury payout.`;
        }
      }

      const claimApprovedForPayout = String(claimForPayout.status || '').trim().toLowerCase() === 'approved'
        || !!String(claimForPayout.approved_at || '').trim();
      if (claimApprovedForPayout && !String(claimForPayout.tx_hash || '').trim() && isAutoRewardPayoutConfigured()) {
        const payoutResult = await tryAutoPayRewardClaim(admin, {
          id: claimForPayout.id,
          wallet_address: claimForPayout.wallet_address || walletAddress,
          status: claimForPayout.status,
          amount_value: claimForPayout.amount_value ?? amountValue,
          reward_currency: claimForPayout.reward_currency || rewardCurrency,
          amount_text: claimForPayout.amount_text || canonicalAmountText,
          admin_note: claimForPayout.admin_note,
          approved_at: claimForPayout.approved_at,
          resolved_at: claimForPayout.resolved_at,
          resolved_by_wallet: claimForPayout.resolved_by_wallet,
          tx_hash: claimForPayout.tx_hash,
          paid_at: claimForPayout.paid_at,
          failure_reason: claimForPayout.failure_reason,
        });
        if (payoutResult.paid) {
          existingPayoutAttempted = !!payoutResult.attempted;
          existingPayoutAttemptId = payoutResult.payoutAttemptId || null;
          existingPayoutFailureReason = null;
          existingStatus = 'paid';
          existingTxHash = payoutResult.txHash || null;
          existingMessage = `${questName} paid automatically from treasury.`;
        } else if (payoutResult.attempted) {
          existingPayoutAttempted = true;
          existingPayoutAttemptId = payoutResult.payoutAttemptId || null;
          existingPayoutFailureReason = payoutResult.failureReason || payoutResult.message || null;
          existingStatus = 'approved';
          existingTxHash = payoutResult.txHash || null;
          existingMessage = `${questName} auto-approved, but treasury payout failed and needs review: ${payoutResult.message}`;
        }
      }

      return json({
        ok: true,
        claimId: existingClaim.id,
        status: existingStatus,
        txHash: existingTxHash,
        rewardCurrency: existingClaim.reward_currency || rewardCurrency || null,
        rewardAmountValue: existingClaim.amount_value ?? amountValue,
        rewardAmountText: existingClaim.amount_text || canonicalAmountText,
        whitelistAutoApproved: false,
        whitelistReason: 'Claim already exists for this wallet and quest today.',
        payoutAttempted: existingPayoutAttempted,
        payoutAttemptId: existingPayoutAttemptId,
        payoutFailureReason: existingPayoutFailureReason,
        message: existingMessage,
      });
    }

    const nowIso = new Date().toISOString();
    const insertPayload = {
      request_key: requestKey,
      wallet_address: walletAddress,
      claim_type: 'daily_quest',
      status: whitelistDecision.autoApprove ? 'approved' : 'pending',
      player_name_snapshot: playerName,
      amount_text: canonicalAmountText,
      amount_value: amountValue,
      reward_currency: rewardCurrency,
      reason_text: questName,
      source_ref: `quest:${questId}${authorizedTestResetCycle > 0 ? `:testcycle_${authorizedTestResetCycle}` : ''}`,
      run_id: qualifyingRun.id,
      claim_day: claimDay,
      approved_at: whitelistDecision.autoApprove ? nowIso : null,
      resolved_at: whitelistDecision.autoApprove ? nowIso : null,
      resolved_by_wallet: whitelistDecision.autoApprove ? 'whitelist:auto' : null,
      admin_note: [whitelistDecision.note || null, authorizedTestResetCycle > 0 ? `Private daily quest test reset cycle ${authorizedTestResetCycle}.` : null].filter(Boolean).join(' ') || null,
    };

    const { data: inserted, error: insertError } = await admin
      .from('reward_claim_requests')
      .insert(insertPayload)
      .select('id, status, requested_at, tx_hash, paid_at, reward_currency, amount_value, amount_text, wallet_address, admin_note, approved_at, resolved_at, resolved_by_wallet, failure_reason')
      .single();
    if (insertError) throw insertError;

    let status = inserted?.status || 'pending';
    let txHash = inserted?.tx_hash || null;
    let payoutAttempted = false;
    let payoutAttemptId: string | null = null;
    let payoutFailureReason: string | null = null;
    let message = whitelistDecision.autoApprove
      ? `${questName} claim auto-approved for this whitelisted wallet.`
      : `${questName} claim sent for payout review.`;

    if (whitelistDecision.autoApprove && inserted?.id) {
      const payoutResult = await tryAutoPayRewardClaim(admin, {
        id: inserted.id,
        wallet_address: inserted.wallet_address || walletAddress,
        status: inserted.status,
        amount_value: inserted.amount_value,
        reward_currency: inserted.reward_currency,
        amount_text: inserted.amount_text || canonicalAmountText,
        admin_note: inserted.admin_note,
        approved_at: inserted.approved_at,
        resolved_at: inserted.resolved_at,
        resolved_by_wallet: inserted.resolved_by_wallet,
        tx_hash: inserted.tx_hash,
        paid_at: inserted.paid_at,
        failure_reason: inserted.failure_reason,
      });
      payoutAttempted = !!payoutResult.attempted;
      payoutAttemptId = payoutResult.payoutAttemptId || null;
      if (payoutResult.paid) {
        status = 'paid';
        txHash = payoutResult.txHash || null;
        message = `${questName} paid automatically from treasury.`;
      } else if (payoutResult.attempted) {
        status = 'approved';
        txHash = payoutResult.txHash || null;
        payoutFailureReason = payoutResult.failureReason || payoutResult.message || null;
        message = `${questName} auto-approved, but treasury payout failed and needs review: ${payoutResult.message}`;
      } else if (isAutoRewardPayoutConfigured()) {
        message = `${questName} auto-approved. ${payoutResult.message}`;
      } else {
        message = `${questName} auto-approved. Set TREASURY_PRIVATE_KEY and the treasury chain env vars in Supabase secrets to enable automatic treasury payouts.`;
      }
    }

    return json({
      ok: true,
      claimId: inserted?.id || null,
      status,
      txHash,
      rewardCurrency: insertPayload.reward_currency,
      rewardAmountValue: amountValue,
      rewardAmountText: canonicalAmountText,
      whitelistAutoApproved: whitelistDecision.autoApprove,
      whitelistReason: whitelistDecision.reason,
      payoutAttempted,
      payoutAttemptId,
      payoutFailureReason,
      testResetCycle: authorizedTestResetCycle || null,
      message,
      qualifyingRunMatchedOn: qualifyingRunLookup.matchedOn || 'completed_at',
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Failed to submit reward claim.' }, 500);
  }
});
