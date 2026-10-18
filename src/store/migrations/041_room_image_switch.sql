-- The room image switch records who flipped it and when, so a paid-capability
-- change is attributable after the fact. Existing rooms keep the default off.
ALTER TABLE rooms ADD COLUMN image_enabled_by TEXT;
ALTER TABLE rooms ADD COLUMN image_enabled_at TEXT;
