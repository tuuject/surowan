-- An operator-driven cutover (today: a published MCP configuration that changed
-- what a running Chat may call) stops running Invocations and rebuilds their
-- Conversation Contexts. The run itself still ends as `aborted`, which says
-- nothing about why, so the cause is recorded here together with the exposed
-- tool names whose calls the runtime could not resolve.
--
-- The continuation queued by that cutover reads both columns and says so in its
-- trusted <runtime_state> line; without them the model would be told the Admin
-- Panel resumed it, which is a different situation (and a different prompt).
-- Every other Invocation leaves both columns NULL.

ALTER TABLE invocations ADD COLUMN abort_cause TEXT;
ALTER TABLE invocations ADD COLUMN abort_unknown_tools TEXT;
