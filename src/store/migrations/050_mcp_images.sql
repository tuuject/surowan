-- Image bytes use the existing local asset store; these are bounded references only.
ALTER TABLE tool_calls ADD COLUMN result_content_json TEXT;
ALTER TABLE agent_messages ADD COLUMN tool_call_id TEXT;

-- Reusing an unreferenced asset renews the existing staging grace window.
ALTER TABLE playground_assets ADD COLUMN last_used_at TEXT;
