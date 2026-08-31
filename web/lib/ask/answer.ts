/**
 * Deliberately tiny Markdown-ish renderer for the answer text. The backend answer is short prose
 * with `[D#]` citation markers, occasional **bold** / _italic_, and an italic `_Poznámka: …_` line.
 * We escape everything first, then apply a fixed whitelist of inline transforms - no HTML from the
 * model reaches the DOM, so no sanitiser dependency is needed.
 */
export function renderAnswer(text: string): string {
  const paragraphs = text.trim().split(/\n{2,}/);
  return paragraphs.map((p) => `<p>${inline(escapeHtml(p))}</p>`).join('');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inline(s: string): string {
  return (
    s
      // [D1] / [D2, D3] -> individual superscript anchors that the view scrolls to
      .replace(/\[(D\d+(?:\s*,\s*D\d+)*)\]/g, (_m, group: string) =>
        group
          .split(/\s*,\s*/)
          .map(
            (ref) =>
              `<sup class="cg-cref"><a href="#${ref}" data-cref="${ref}">${ref}</a></sup>`
          )
          .join('')
      )
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])_([^_]+)_(?=$|[\s.,;:)])/g, '$1<em>$2</em>')
      .replace(/\n/g, '<br />')
  );
}
