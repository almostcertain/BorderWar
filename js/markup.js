// Basic markup for the What's new post, shared by the game menu (UI.setupNews)
// and the admin page's preview (server/admin.html). Client-only.
//
//   # Heading   ## Smaller heading   - list item (or * item)
//   **bold**   *italic*   [link text](https://...)   bare https:// links
//
// Builds DOM nodes and never parses HTML, so a post can't inject markup.
const Markup = {
  INLINE: /(\*\*[^*\n]+\*\*|\*[^*\s](?:[^*\n]*[^*\s])?\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<>"]+)/,

  link(href, text) {
    const a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = text;
    return a;
  },

  inline(parent, text) {
    for (const part of text.split(this.INLINE)) {
      if (!part) continue;
      let m;
      if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) {
        this.inline(parent.appendChild(document.createElement('strong')), part.slice(2, -2));
      } else if (part.length > 2 && part[0] === '*' && part.endsWith('*')) {
        this.inline(parent.appendChild(document.createElement('em')), part.slice(1, -1));
      } else if ((m = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(part))) {
        parent.appendChild(this.link(m[2], m[1]));
      } else if (/^https?:\/\//.test(part)) {
        // Punctuation ending a sentence isn't part of the address.
        const url = part.replace(/[.,;:!?)\]]+$/, '');
        parent.appendChild(this.link(url, url));
        if (url.length < part.length) parent.appendChild(document.createTextNode(part.slice(url.length)));
      } else {
        parent.appendChild(document.createTextNode(part));
      }
    }
  },

  // Replaces `el`'s content with `text` rendered as markup.
  render(el, text) {
    el.textContent = '';
    let para = null, list = null;
    for (const raw of String(text).split('\n')) {
      const line = raw.trim();
      const head = /^(#{1,2})\s+(.+)$/.exec(line);
      const item = /^[-*]\s+(.+)$/.exec(line);
      if (!item) list = null;
      if (!line || head || item) para = null;
      if (!line) continue;
      if (head) {
        this.inline(el.appendChild(document.createElement(head[1].length === 1 ? 'h3' : 'h4')), head[2]);
      } else if (item) {
        if (!list) list = el.appendChild(document.createElement('ul'));
        this.inline(list.appendChild(document.createElement('li')), item[1]);
      } else {
        if (para) para.appendChild(document.createElement('br'));
        else para = el.appendChild(document.createElement('p'));
        this.inline(para, line);
      }
    }
  }
};
