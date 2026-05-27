import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const DEFAULT_SHOP_WALLET = "0xab45288409900be5ef23c19726a30c28268495ad";

function normalizeAddress(value: unknown) {
  const text = String(value || "").trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(text) ? text : "";
}

function normalizeHash(value: unknown) {
  const text = String(value || "").trim().toLowerCase();
  return /^0x[a-f0-9]{64}$/.test(text) ? text : "";
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function createAdmin() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const buyerWallet = normalizeAddress(body.buyerWallet || body.walletAddress);
    const shopWallet = normalizeAddress(body.shopWallet) || normalizeAddress(Deno.env.get("DFK_HERO_SHOP_WALLET")) || DEFAULT_SHOP_WALLET;
    const heroId = String(body.heroId || "").trim();
    const txHash = normalizeHash(body.txHash);
    const paymentSessionId = String(body.paymentSessionId || "").trim();
    const paymentCurrency = String(body.paymentCurrency || body.currency || "").trim().toUpperCase();
    const paymentAsset = String(body.paymentAsset || "").trim().toLowerCase();
    const expectedAmountWei = String(body.expectedAmountWei || "0").trim();
    const hero = body.hero && typeof body.hero === "object" && !Array.isArray(body.hero) ? body.hero as Record<string, unknown> : {};
    const metadata = body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata) ? body.metadata as Record<string, unknown> : {};

    if (!buyerWallet) return json({ error: "buyerWallet is required." }, 400);
    if (!heroId) return json({ error: "heroId is required." }, 400);
    if (!txHash) return json({ error: "txHash is required." }, 400);
    if (!["RON", "JEWEL", "AVAX"].includes(paymentCurrency)) return json({ error: "Unsupported payment currency." }, 400);
    if (!expectedAmountWei || expectedAmountWei === "0") return json({ error: "expectedAmountWei is required." }, 400);

    const admin = createAdmin();
    let paymentFound = false;

    if (paymentCurrency === "AVAX") {
      let query = admin
        .from("crypto_payment_sessions")
        .select("id,wallet_address,kind,status,expected_amount_wei,payment_tx_hash")
        .eq("wallet_address", buyerWallet)
        .eq("payment_tx_hash", txHash)
        .eq("status", "confirmed")
        .limit(1);
      if (paymentSessionId) query = query.eq("id", paymentSessionId);
      const { data, error } = await query.maybeSingle();
      if (error) throw error;
      paymentFound = !!data
        && String(data.kind || "") === "hero_shop_purchase"
        && String(data.expected_amount_wei || "0") === expectedAmountWei;
    } else {
      let query = admin
        .from("dfk_token_payments")
        .select("payment_session_id,wallet_address,kind,expected_amount_wei,tx_hash,payment_asset")
        .eq("wallet_address", buyerWallet)
        .eq("tx_hash", txHash)
        .limit(1);
      if (paymentSessionId) query = query.eq("payment_session_id", paymentSessionId);
      const { data, error } = await query.maybeSingle();
      if (error) throw error;
      paymentFound = !!data
        && String(data.kind || "") === "hero_shop_purchase"
        && String(data.expected_amount_wei || "0") === expectedAmountWei
        && String(data.payment_asset || "").toLowerCase() === paymentAsset;
    }

    if (!paymentFound) return json({ error: "Verified hero shop payment was not found yet." }, 409);

    const row = {
      buyer_wallet: buyerWallet,
      shop_wallet: shopWallet,
      hero_id: heroId,
      chain_id: Number(hero.chainId || hero.chain_id || 53935),
      chain_name: String(hero.chainName || hero.chain_name || "dfk"),
      class_name: hero.className ? String(hero.className) : null,
      rarity_name: hero.rarityName ? String(hero.rarityName) : null,
      level: Number.isFinite(Number(hero.level)) ? Number(hero.level) : null,
      payment_currency: paymentCurrency,
      payment_asset: paymentAsset || (paymentCurrency === "RON" ? "native_ron" : paymentCurrency === "JEWEL" ? "native_jewel" : "native_avax"),
      expected_amount_wei: expectedAmountWei,
      payment_session_id: paymentSessionId || null,
      tx_hash: txHash,
      status: "paid",
      metadata: { ...metadata, hero },
    };

    const { data: purchase, error: upsertError } = await admin
      .from("hero_shop_purchases")
      .upsert(row, { onConflict: "tx_hash" })
      .select("id,status,created_at")
      .single();
    if (upsertError) throw upsertError;

    return json({ ok: true, purchase });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Could not record hero shop purchase." }, 500);
  }
});
