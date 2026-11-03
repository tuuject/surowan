-- Tool images are no longer MCP-only: member avatars use the same reference
-- shape and the same marker. Retained history and tool audit rows written by
-- 050 still carry the MCP-only key and marker, so rewrite them in place rather
-- than dropping the pixels out of every replayed context.
UPDATE context_messages
SET payload_json = replace(replace(payload_json, '"mcpImages"', '"toolImages"'), '[MCP image ', '[image ')
WHERE payload_json LIKE '%"mcpImages"%';

UPDATE tool_calls
SET result_content_json = replace(
    replace(result_content_json, '"mcpImages"', '"toolImages"'),
    '[MCP image ',
    '[image '
  )
WHERE result_content_json IS NOT NULL AND result_content_json LIKE '%"mcpImages"%';
