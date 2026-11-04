-- Reference data: businesses, metric definitions and the known source connections with their honest status.
-- No business figures. Rollback: db/rollback/003_reference_data.down.sql

insert into businesses (id, name, sort_order) values
  ('sb', 'Succulents Box', 1),
  ('p2s', 'P2S', 2),
  ('perksradar', 'Perksradar', 3);

insert into metric_definitions (key, label, unit, kind, good_direction, numerator, denominator, acquisition_event, description) values
  ('revenue', 'Revenue', 'currency', 'base', 'up', null, null, null, 'Net sales as reported by the source, in the source scope'),
  ('orders', 'Orders', 'count', 'base', 'up', null, null, null, null),
  ('units', 'Units', 'count', 'base', 'up', null, null, null, null),
  ('sessions', 'Sessions', 'count', 'base', 'up', null, null, null, 'Sessions in the stated scope (for example US, humans and bots)'),
  ('sessions_added_to_cart', 'Sessions with add to cart', 'count', 'base', 'up', null, null, null, null),
  ('sessions_reached_checkout', 'Sessions reaching checkout', 'count', 'base', 'up', null, null, null, null),
  ('sessions_converted', 'Sessions completing checkout', 'count', 'base', 'up', null, null, null, null),
  ('bot_sessions', 'Bot sessions', 'count', 'base', 'down', null, null, null, 'An increase is not a good sign'),
  ('human_sessions', 'Human sessions', 'count', 'base', 'up', null, null, null, null),
  ('ad_spend', 'Advertising spend', 'currency', 'base', 'neutral', null, null, null, null),
  ('ad_purchases', 'Ad-attributed purchases', 'count', 'base', 'up', null, null, 'purchase', 'Per platform attribution setting'),
  ('ad_purchase_value', 'Ad-attributed purchase value', 'currency', 'base', 'up', null, null, 'purchase', null),
  ('gross_profit', 'Gross profit', 'currency', 'base', 'up', null, null, null, 'Saved result from the profit application'),
  ('gross_profit_revenue_basis', 'Revenue basis for gross profit', 'currency', 'base', 'neutral', null, null, null, 'The revenue a gross profit figure was calculated on, sent with it by the same integration. Used only as the gross margin denominator; never part of business or channel revenue.'),
  ('product_cost', 'Product cost', 'currency', 'base', 'neutral', null, null, null, null),
  ('shipping_cost', 'Shipping cost', 'currency', 'base', 'neutral', null, null, null, null),
  ('signups', 'Sign-ups', 'count', 'base', 'up', null, null, null, null),
  ('cards_added', 'Cards added', 'count', 'base', 'up', null, null, null, null),
  ('reminders_sent', 'Reminders sent', 'count', 'base', 'neutral', null, null, null, null),
  ('emails_delivered', 'Emails delivered', 'count', 'base', 'up', null, null, null, null),
  ('emails_opened', 'Emails opened', 'count', 'base', 'up', null, null, null, null),
  ('emails_clicked', 'Emails clicked', 'count', 'base', 'up', null, null, null, null),
  ('aov', 'Average order value', 'currency', 'derived', 'up', 'revenue', 'orders', null, null),
  ('add_to_cart_rate', 'Added-to-cart rate', 'percent', 'derived', 'up', 'sessions_added_to_cart', 'sessions', null, null),
  ('checkout_rate', 'Reached-checkout rate', 'percent', 'derived', 'up', 'sessions_reached_checkout', 'sessions', null, null),
  ('conversion_rate', 'Purchase conversion rate', 'percent', 'derived', 'up', 'sessions_converted', 'sessions', null, null),
  ('cpa', 'Cost per purchase (CPA)', 'currency', 'derived', 'down', 'ad_spend', 'ad_purchases', 'purchase', 'Shown as N/A (<1 purchase) below one purchase'),
  ('roas', 'ROAS', 'multiple', 'derived', 'up', 'ad_purchase_value', 'ad_spend', 'purchase', null),
  ('margin', 'Gross margin', 'percent', 'derived', 'up', 'gross_profit', 'gross_profit_revenue_basis', null, 'Gross profit divided by the revenue basis sent with it by the same integration, for the same business, period, timezone and scope. Never divided by business revenue.'),
  ('reported_roas', 'ROAS (as reported)', 'multiple', 'reported_ratio', 'up', null, null, null, 'Kept at its original scope'),
  ('reported_cpa', 'CPA (as reported)', 'currency', 'reported_ratio', 'down', null, null, null, 'Kept at its original scope');

-- Known integrations start as not connected. Details of each integration are kept in the team's private notes.
insert into source_connections (id, label, business_id, kind, status, blocked_reason, config) values
  ('submission.api', 'Direct submissions (API)', null, 'submission', 'not_configured', null, '{"seeded":"true"}'),
  ('sheet.intake', 'Intake spreadsheet (scheduled task results)', null, 'spreadsheet', 'not_configured', null, '{"seeded":"true"}'),
  ('pull.plant_breakdown', 'Plant Revenue Breakdown', 'sb', 'pull', 'not_configured', null, '{"seeded":"true"}'),
  ('blocked.gross_profit', 'Gross Profit', 'sb', 'pull', 'blocked', 'Needs a read-only reporting endpoint in that app before it can connect.', '{"seeded":"true"}'),
  ('blocked.corporate_gifting', 'Corporate Gifting', 'sb', 'pull', 'blocked', 'Needs a read-only reporting endpoint in that app before it can connect. Detailed editing stays in that app.', '{"seeded":"true"}'),
  ('blocked.task_tracker', 'Task Tracker', null, 'pull', 'blocked', 'Has no shared data to read. Marketing tasks are managed in this dashboard.', '{"seeded":"true"}'),
  ('blocked.content_intelligence', 'Content Intelligence', 'sb', 'pull', 'blocked', 'Needs a read-only summary endpoint, or content counts added to the intake spreadsheet.', '{"seeded":"true"}'),
  ('manual.upload', 'Manual uploads', null, 'manual', 'ok', null, '{"seeded":"true"}');
