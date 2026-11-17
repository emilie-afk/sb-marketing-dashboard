-- Rolls back 011. Plans and their assignment links are deleted; tasks already created in Task Tracker stay there.
drop table if exists plan_assignments;
drop table if exists marketing_plans;
delete from schema_migrations where name = '011_marketing_plans.sql';
