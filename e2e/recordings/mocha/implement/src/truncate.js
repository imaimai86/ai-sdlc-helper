/** <text> cut to <max> characters, the last one an ellipsis, when it is longer than <max>. */
export function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
