-- An administrator may resume the latest invocation of a Conversation after it
-- failed: a new queued invocation opens with an empty batch and continues from
-- the canonical Context instead of re-injecting the failed batch. The new row
-- names the run it resumed, so the panel can link the two and the runtime can
-- tell the model why it is running without new messages.
--
-- The link is audit, not ownership: when retention or a Chat deletion removes
-- the resumed run, the pointer is cleared rather than blocking the delete. The
-- index keeps that ON DELETE SET NULL lookup from scanning every invocation for
-- each deleted row.

ALTER TABLE invocations ADD COLUMN resumed_from_invocation_id INTEGER REFERENCES invocations(id) ON DELETE SET NULL;

CREATE INDEX invocations_resumed_from_idx ON invocations(resumed_from_invocation_id);
