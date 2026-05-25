import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { DFK_CHAIN_ID, DFK_HONK_PAYMENT_ASSET, DFK_HONK_TOKEN_ADDRESS, DFK_JEWEL_PAYMENT_ASSET, RONIN_CHAIN_ID, RON_TREASURY_ADDRESS, TREASURY_ADDRESS } from "../_shared/env.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json();
    const walletAddress = String(body.walletAddress || "").trim().toLowerCase();
    const clientRunId = String(body.clientRunId || "").trim();
    const kind = String(body.kind || "").trim();
    const expectedAmountWei = String(body.expectedAmountWei || "0").trim();
    const metadata = body.metadata && typeof body.metadata === "object" ? body.metadata : {};
    const chainId = Number(body.chainId || DFK_CHAIN_ID);
    const requestedPaymentAsset = String(body.paymentAsset || body.currency || DFK_JEWEL_PAYMENT_ASSET).trim().toLowerCase();
    const isRonPayment = requestedPaymentAsset === "native_ron" || requestedPaymentAsset === "ron";
    const paymentAsset = isRonPayment
      ? "native_ron"
      : (requestedPaymentAsset === DFK_HONK_PAYMENT_ASSET || requestedPaymentAsset === "honk" || requestedPaymentAsset === "honk_erc20" ? DFK_HONK_PAYMENT_ASSET : DFK_JEWEL_PAYMENT_ASSET);
    const tokenAddress = paymentAsset === DFK_HONK_PAYMENT_ASSET ? DFK_HONK_TOKEN_ADDRESS : "native";
    const treasuryAddress = isRonPayment ? RON_TREASURY_ADDRESS : TREASURY_ADDRESS;

    if (!walletAddress || !clientRunId || !kind || !expectedAmountWei) {
      throw new Error("walletAddress, clientRunId, kind, and expectedAmountWei are required.");
    }
    if (isRonPayment) {
      if (chainId !== RONIN_CHAIN_ID) throw new Error("Invalid chainId for Ronin RON payment.");
    } else if (chainId !== DFK_CHAIN_ID) {
      throw new Error("Invalid chainId for DFK Chain payment.");
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data, error } = await supabase
      .from("dfk_token_payment_sessions")
      .insert({
        wallet_address: walletAddress,
        client_run_id: clientRunId,
        kind,
        expected_amount_wei: expectedAmountWei,
        chain_id: chainId,
        token_address: tokenAddress,
        payment_asset: paymentAsset,
        treasury_address: treasuryAddress,
        metadata,
        status: "pending",
      })
      .select("id")
      .single();

    if (error) throw error;

    return Response.json({
      ok: true,
      paymentSessionId: data.id,
      chainId,
      paymentAsset,
      tokenAddress,
      treasuryAddress,
    }, { headers: corsHeaders });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unknown error" }, {
      status: 400,
      headers: corsHeaders,
    });
  }
});
