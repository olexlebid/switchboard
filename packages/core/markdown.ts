// Tiny, dependency-free and safe markdown renderer for agent replies in the chat.
// Everything is HTML-escaped FIRST; only a small whitelist of constructs is turned back into tags,
// and links are limited to http(s). No raw HTML from the agent ever reaches the page.

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c]!);

/** Inline constructs on already-escaped text: `code`, **bold**, *italic*, [text](https://url). */
function inline(escaped: string): string {
  const codes: string[] = [];
  let out = escaped.replace(/`([^`\n]+)`/g, (_, c: string) => {
    codes.push(`<code>${c}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = out
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, text: string, url: string) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`);
  return out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)]!);
}

export function renderMarkdown(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const html: string[] = [];
  let para: string[] = [];
  let list: { tag: 'ul' | 'ol'; items: string[] } | undefined;

  const flushPara = () => {
    if (para.length) html.push(`<p>${para.map((l) => inline(escapeHtml(l))).join('<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) html.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(escapeHtml(i))}</li>`).join('')}</${list.tag}>`);
    list = undefined;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      flushPara(); flushList();
      const code: string[] = [];
      for (i++; i < lines.length && !/^```\s*$/.test(lines[i]!); i++) code.push(lines[i]!);
      html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (heading) { flushPara(); flushList(); html.push(`<p><strong>${inline(escapeHtml(heading[1]!))}</strong></p>`); }
    else if (ul || ol) {
      flushPara();
      const tag = ul ? 'ul' : 'ol';
      if (list && list.tag !== tag) flushList();
      list ??= { tag, items: [] };
      list.items.push((ul ?? ol)![1]!);
    } else if (line.trim() === '') { flushPara(); flushList(); }
    else { flushList(); para.push(line); }
  }
  flushPara(); flushList();
  return html.join('');
}
