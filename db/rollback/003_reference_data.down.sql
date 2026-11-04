-- Rolls back 003 reference rows. Fails if imported data references them (by design).
delete from source_connections where id in (select id from source_connections where config->>'seeded' = 'true');
delete from metric_definitions;
delete from businesses where id in ('sb', 'p2s', 'perksradar');
delete from schema_migrations where name = '003_reference_data.sql';
