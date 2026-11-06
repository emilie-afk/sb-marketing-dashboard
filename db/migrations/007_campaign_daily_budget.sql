-- Daily budget of a campaign as observed when its period result was collected (the budget can change during a
-- period, so it is a point-in-time setting, not a period total). Empty when the platform has no daily budget
-- (e.g. a lifetime budget); budget_note says why or how it was derived (e.g. "sum of ad set budgets").
alter table campaign_performance add column daily_budget numeric check (daily_budget is null or daily_budget >= 0);
alter table campaign_performance add column budget_note text check (budget_note is null or length(budget_note) <= 120);
