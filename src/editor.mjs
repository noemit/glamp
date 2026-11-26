import { Editor, Extension, mergeAttributes } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import { Markdown, MarkdownManager } from '@tiptap/markdown';

const CARD_LINK_RE = /^\/\?card=([a-zA-Z0-9_-]{1,128})$/;

export function safeHref(raw, origin) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const direct = CARD_LINK_RE.exec(trimmed);
  if (direct) return `/?card=${direct[1]}`;
  try {
    const u = new URL(trimmed);
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) return null;
    if (origin && u.origin === origin && u.pathname === '/') {
      const cid = u.searchParams.get('card');
      if (cid && /^[a-zA-Z0-9_-]{1,128}$/.test(cid)) return `/?card=${cid}`;
    }
    return u.href;
  } catch {
    return null;
  }
}

export function cardIdFromHref(href) {
  const m = typeof href === 'string' ? CARD_LINK_RE.exec(href.trim()) : null;
  return m ? m[1] : null;
}

const SafeLink = Link.extend({
  parseMarkdown(token, helpers) {
    const origin = typeof location !== 'undefined' ? location.origin : undefined;
    const href = safeHref(token.href, origin);
    const children = helpers.parseInline(token.tokens || []);
    if (!href) return children;
    return helpers.applyMark('link', children, {
      href,
      title: token.title || null,
    });
  },
  renderHTML({ HTMLAttributes }) {
    const origin = typeof location !== 'undefined' ? location.origin : undefined;
    const href = safeHref(HTMLAttributes.href, origin);
    if (!href) return ['span', {}, 0];
    const cid = cardIdFromHref(href);
    if (cid) {
      return ['a', mergeAttributes({ href, 'data-card-link': cid, class: 'editor-card-link' }), 0];
    }
    return ['a', mergeAttributes({ href, target: '_blank', rel: 'noopener noreferrer' }), 0];
  },
});

export function buildExtensions({ placeholder = 'Write notes in Markdown…', onSaveShortcut } = {}) {
  const origin = typeof location !== 'undefined' ? location.origin : undefined;
  const exts = [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      underline: false,
      link: false,
    }),
    SafeLink.configure({
      openOnClick: false,
      autolink: true,
      linkOnPaste: true,
      defaultProtocol: 'https',
      protocols: ['http', 'https'],
      isAllowedUri: (url) => Boolean(safeHref(url, origin)),
    }),
    Markdown.configure({
      markedOptions: { gfm: true, breaks: false },
    }),
  ];
  if (placeholder) {
    exts.push(Placeholder.configure({ placeholder }));
  }
  if (onSaveShortcut) {
    exts.push(
      Extension.create({
        name: 'saveShortcut',
        addKeyboardShortcuts() {
          return {
            'Mod-s': () => {
              onSaveShortcut();
              return true;
            },
          };
        },
      }),
    );
  }
  return exts;
}

export function cleanMarkdownOutput(md) {
  if (typeof md !== 'string') return '';
  const cleaned = md
    .replace(/\r\n?/g, '\n')
    .replace(/(?:^|\n)(?:&nbsp;|\u00a0)[ \t]*(?=\n|$)/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned === '&nbsp;' || cleaned === '\u00a0' ? '' : cleaned;
}

export function roundTripMarkdown(md) {
  const kit = StarterKit.configure({ heading: { levels: [1, 2, 3] }, underline: false, link: false });
  const exts = [
    ...kit.config.addExtensions.call({ options: kit.options }),
    SafeLink.configure({ openOnClick: false, protocols: ['http', 'https'], isAllowedUri: (u) => Boolean(safeHref(u)) }),
  ];
  const mgr = new MarkdownManager({ extensions: exts, markedOptions: { gfm: true, breaks: false } });
  const doc = mgr.parse(md || '');
  return { doc, markdown: cleanMarkdownOutput(mgr.serialize(doc)) };
}

export function createMarkdownEditor({
  element,
  content = '',
  placeholder = 'Write notes in Markdown…',
  onUpdate,
  onSelectionUpdate,
  onFocus,
  onBlur,
  onSaveShortcut,
}) {
  const editor = new Editor({
    element,
    injectCSS: false,
    extensions: buildExtensions({ placeholder, onSaveShortcut }),
    content: content || '',
    contentType: 'markdown',
    editorProps: {
      attributes: {
        class: 'glamp-editor md-body',
        spellcheck: 'true',
        'aria-label': 'Card body',
      },
    },
    onUpdate: () => onUpdate?.(),
    onSelectionUpdate: () => onSelectionUpdate?.(),
    onFocus: () => onFocus?.(),
    onBlur: () => onBlur?.(),
  });

  return {
    getMarkdown() {
      if (editor.isEmpty) return '';
      const raw = typeof editor.getMarkdown === 'function' ? editor.getMarkdown() : editor.storage.markdown?.getMarkdown?.() || '';
      return cleanMarkdownOutput(raw);
    },
    setMarkdown(md) {
      editor.commands.setContent(md || '', { contentType: 'markdown', emitUpdate: false });
    },
    isEmpty() {
      return editor.isEmpty;
    },
    focus() {
      editor.commands.focus();
    },
    destroy() {
      editor.destroy();
    },
    activeState() {
      const linkAttrs = editor.getAttributes('link');
      return {
        h2: editor.isActive('heading', { level: 2 }),
        h3: editor.isActive('heading', { level: 3 }),
        bold: editor.isActive('bold'),
        italic: editor.isActive('italic'),
        strike: editor.isActive('strike'),
        code: editor.isActive('code'),
        codeBlock: editor.isActive('codeBlock'),
        blockquote: editor.isActive('blockquote'),
        bulletList: editor.isActive('bulletList'),
        orderedList: editor.isActive('orderedList'),
        link: editor.isActive('link'),
        linkHref: linkAttrs?.href || '',
        linkCardId: cardIdFromHref(linkAttrs?.href || ''),
      };
    },
    exec(cmd, arg) {
      const chain = editor.chain().focus();
      switch (cmd) {
        case 'h2': return chain.toggleHeading({ level: 2 }).run();
        case 'h3': return chain.toggleHeading({ level: 3 }).run();
        case 'bold': return chain.toggleBold().run();
        case 'italic': return chain.toggleItalic().run();
        case 'strike': return chain.toggleStrike().run();
        case 'code': return chain.toggleCode().run();
        case 'codeBlock': return chain.toggleCodeBlock().run();
        case 'blockquote': return chain.toggleBlockquote().run();
        case 'bulletList': return chain.toggleBulletList().run();
        case 'orderedList': return chain.toggleOrderedList().run();
        case 'hr': return chain.setHorizontalRule().run();
        case 'undo': return chain.undo().run();
        case 'redo': return chain.redo().run();
        case 'unsetLink': return chain.extendMarkRange('link').unsetLink().run();
        case 'setLink': {
          const origin = typeof location !== 'undefined' ? location.origin : undefined;
          const href = safeHref(arg?.href, origin);
          if (!href) return false;
          if (editor.state.selection.empty) {
            const label = (arg?.label || href).trim();
            return chain
              .insertContent([
                { type: 'text', text: label, marks: [{ type: 'link', attrs: { href } }] },
                { type: 'text', text: ' ' },
              ])
              .run();
          }
          return chain.extendMarkRange('link').setLink({ href }).run();
        }
        case 'insertCardLink': {
          const id = arg?.id;
          const title = (arg?.title || id || '').trim();
          if (!id || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) return false;
          const href = `/?card=${id}`;
          if (!editor.state.selection.empty) {
            return chain.extendMarkRange('link').setLink({ href }).run();
          }
          return chain
            .insertContent([
              { type: 'text', text: title, marks: [{ type: 'link', attrs: { href } }] },
              { type: 'text', text: ' ' },
            ])
            .run();
        }
        default:
          return false;
      }
    },
  };
}
