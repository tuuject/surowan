-- The room timeline reads each message's input state by `message_id`, and
-- retention's `ON DELETE SET NULL` looks rows up by it too. The ledger keeps
-- its tombstones for good, so neither may scan the whole table.
CREATE INDEX playground_inputs_message_idx
  ON playground_inputs(message_id)
  WHERE message_id IS NOT NULL;
