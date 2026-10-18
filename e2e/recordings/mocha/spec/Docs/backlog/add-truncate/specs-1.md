# Spec: add-truncate

`truncate(text, max)` in `src/truncate.js`: text of at most `max` characters is returned unchanged; longer text is
cut to its first `max - 1` characters followed by "…" (so the result is `max` characters long).

## Acceptance criteria
- `truncate('hello', 10)` is 'hello'.
- `truncate('hello world', 6)` is 'hello…'.
