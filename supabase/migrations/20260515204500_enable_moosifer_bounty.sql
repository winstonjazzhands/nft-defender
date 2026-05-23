insert into public.moosifer_bounty_state (id, reward_enabled, reward_amount, reward_currency)
values (true, true, 500, 'JEWEL')
on conflict (id) do update
set reward_enabled = true,
    reward_amount = excluded.reward_amount,
    reward_currency = excluded.reward_currency,
    updated_at = now()
where public.moosifer_bounty_state.claimed_at is null;
