import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cardIdFromHref, cleanMarkdownOutput, roundTripMarkdown, safeHref } from '../src/editor.mjs';

test('simple Markdown editor round-trips core syntax and strips unsafe links/HTML', () => {
  const input = [
    '## Weekly Brief',
    '',
    'Ship **bold**, *italic*, ~~strike~~, and `code` with [Launch Plan](/?card=550e8400-e29b-41d4-a716-446655440000) and [Docs](https://example.com/docs).',
    '',
    '> Keep simple Markdown clean.',
    '',
    '- First bullet',
    '- Second bullet',
    '',
    '1. Step one',
    '2. Step two',
    '',
    '---',
    '',
    '```js',
    'const ok = true;',
    '```',
  ].join('\n');

  const { markdown } = roundTripMarkdown(input);
  assert.match(markdown, /^## Weekly Brief/m);
  assert.match(markdown, /\*\*bold\*\*/);
  assert.match(markdown, /\*italic\*/);
  assert.match(markdown, /~~strike~~/);
  assert.match(markdown, /`code`/);
  assert.match(markdown, /\[Launch Plan\]\(\/\?card=550e8400-e29b-41d4-a716-446655440000\)/);
  assert.match(markdown, /\[Docs\]\(https:\/\/example\.com\/docs\)/);
  assert.match(markdown, /^> Keep simple Markdown clean\./m);
  assert.match(markdown, /^- First bullet/m);
  assert.match(markdown, /^1\. Step one/m);
  assert.match(markdown, /```js[\s\S]*const ok = true;/);

  // Unsafe URI schemes are stripped to plain text (never a link mark)
  const { doc, markdown: sanitized } = roundTripMarkdown('Click [evil](javascript:alert(1)) or [data](data:text/html,hi) safely.');
  assert.equal(JSON.stringify(doc).includes('javascript:'), false);
  assert.equal(JSON.stringify(doc).includes('data:text/html'), false);
  assert.equal(sanitized, 'Click evil or data safely.');

  // safeHref & cardIdFromHref checks
  assert.equal(safeHref('javascript:alert(1)'), null);
  assert.equal(safeHref('https://user:pass@example.com'), null);
  assert.equal(safeHref('/?card=abc_123'), '/?card=abc_123');
  assert.equal(safeHref('https://glamp.test/?card=abc_123', 'https://glamp.test'), '/?card=abc_123');
  assert.equal(cardIdFromHref('/?card=abc_123'), 'abc_123');
  assert.equal(cleanMarkdownOutput('&nbsp;\n\n'), '');
});
