-- 0011 was originally:
--   CREATE TABLE bot_recommendations
--   CREATE TABLE recommendation_subscriptions
--   CREATE TABLE recommendation_outcomes
-- plus 5 indexes.
--
-- All of that is also created by 0012_slippery_puppet_master.sql (which
-- additionally adds the settlementOrder* columns + indexes on p2p_ads). Running both
-- migrations in order on a fresh DB failed with
--   "Table 'bot_recommendations' already exists"
-- on the second `CREATE TABLE`. This was the v3 audit blocker breaking
-- deployed via CI/CD pre-deploy command.
--
-- 0011 is emptied to a no-op here. The journal still records it as applied
-- so existing DBs that already ran 0011 don't replay (idempotent). New DBs
-- pick up the canonical schema from 0012 onward. Don't add anything to
-- this file.

SELECT 1;
