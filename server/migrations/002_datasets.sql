-- 002_datasets.sql · per-cohort remediation settings for multiple device datasets.
ALTER TABLE sim_device_behavior ADD COLUMN affected_config TEXT;
ALTER TABLE sim_device_behavior ADD COLUMN target_config TEXT;
