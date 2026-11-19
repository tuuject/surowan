-- Image asset search metadata: administrator-managed keywords, and the
-- agent-visibility flag (promotion is an admin action, so every existing and
-- newly created asset starts private). The Drizzle definitions live in
-- packages/image-service (image schema); this migration is the authoritative DDL.
ALTER TABLE image_assets ADD COLUMN keywords TEXT NOT NULL DEFAULT '';
ALTER TABLE image_assets ADD COLUMN agent_visible INTEGER NOT NULL DEFAULT 0;
