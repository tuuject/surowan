-- `generation` fences writes from a run that still holds a header from before
-- the Context was reset. `/cut_topic`, `/rebuild_context`, a system-prompt
-- change and a model-budget change all bump it, so a late `message_end` from
-- the aborted run cannot append into the new history or move its `head_seq`.
ALTER TABLE conversation_contexts ADD COLUMN generation INTEGER NOT NULL DEFAULT 1;

-- The model budget the retained transcript was built under. A hot reload that
-- changes `context_window` or `max_tokens` compares against these values and
-- rebuilds the Context from chat history when the retained transcript no longer
-- fits. NULL marks rows created before 052: the first run adopts the budget
-- without discarding history.
ALTER TABLE conversation_contexts ADD COLUMN context_window INTEGER;
ALTER TABLE conversation_contexts ADD COLUMN max_output_tokens INTEGER;
