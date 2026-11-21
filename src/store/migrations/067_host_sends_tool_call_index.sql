-- The live Invocation streams ask "which sends belong to this Invocation's
-- tool calls?" once per tick and per open page. Without this index the answer
-- was a scan of the whole `host_sends` ledger with a primary-key probe back
-- into `tool_calls` (≈9 ms at 100k sends); with it, the plan drives from the
-- Invocation's own `tool_calls` rows and probes this index instead.
CREATE INDEX host_sends_tool_call_idx ON host_sends(tool_call_id);
