-- Phase A3 — partial-failure recovery for the market-maker setup flow.
--
-- When the orchestrator deposits liquidity into the the venue Vault but the
-- subsequent /orders submission fails (transient 5xx, signature rejection,
-- user closes the modal mid-way), the user's funds were stranded in the
-- vault with no recovery UI. settlementDepositTxHash records the broadcasted
-- deposit so the next ad row visit can offer a "Retry placement" CTA.
--
-- Nullable, additive — existing rows unaffected.

ALTER TABLE `p2p_ads` ADD COLUMN `settlementDepositTxHash` varchar(66);
