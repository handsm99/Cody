import { describe, expect, it } from 'vitest'

import { renderCodyMarkdown } from './markdown'

const complicatedMarkdown = [
    '# This is a heading',
    '',
    '## This is a subheading',
    '',
    'Some text',
    'in the same paragraph',
    'with a [link](./destination).',
    '',
    '```ts',
    'const someTypeScriptCode = funcCall()',
    '```',
    '',
    '- bullet list item 1',
    '- bullet list item 2',
    '',
    '1. item 1',
    '  ```ts',
    '  const codeInsideTheBulletPoint = "string"',
    '  ```',
    '1. item 2',
    '',
    '> quoted',
    '> text',
    '',
    '| col 1 | col 2 |',
    '|-------|-------|',
    '| A     | B     |',
    '',
    '![image alt text](./src.jpg)',
    '',
    '<b>inline html</b>',
    '',
    'Escaped \\* markdown and escaped html code \\&gt\\;',
].join('\n')

describe('renderCodyMarkdown', () => {
    it('renders code blocks, with syntax highlighting', () => {
        expect(renderCodyMarkdown(complicatedMarkdown)).toMatchInlineSnapshot(`
          "<h1>This is a heading</h1>
          <h2>This is a subheading</h2>
          <p>Some text<br>in the same paragraph<br>with a <a>link</a>.</p>
          <pre><code class="language-ts"><span class="hljs-keyword">const</span> someTypeScriptCode = funcCall()
          </code></pre>
          <ul>
          <li>bullet list item 1</li>
          <li>bullet list item 2</li>
          </ul>
          <ol>
          <li>item 1<pre><code class="language-ts"><span class="hljs-keyword">const</span> codeInsideTheBulletPoint = <span class="hljs-string">"string"</span>
          </code></pre>
          </li>
          <li>item 2</li>
          </ol>
          <blockquote>
          <p>quoted<br>text</p>
          </blockquote>
          <table>
          <thead>
          <tr>
          <th>col 1</th>
          <th>col 2</th>
          </tr>
          </thead>
          <tbody><tr>
          <td>A</td>
          <td>B</td>
          </tr>
          </tbody></table>
          <p></p>
          <p><b>inline html</b></p>
          <p>Escaped * markdown and escaped html code &amp;gt;</p>"
        `)
    })
    it('sanitizes script tags', () => {
        expect(renderCodyMarkdown('<script>evil();</script>')).toBe('')
    })
    it('sanitizes event handlers', () => {
        expect(renderCodyMarkdown('<b onclick="evil()">test</b></svg>')).toBe('<p><b>test</b></p>')
    })
    it('does not allow arbitrary <object> tags', () => {
        expect(renderCodyMarkdown('<object data="something"></object>')).toBe('<p></p>')
    })
    it('drops SVG <object> tags', () => {
        expect(renderCodyMarkdown('<object data="something" type="image/svg+xml"></object>')).toBe('<p></p>')
    })
    it('forbids <svg> tags', () => {
        const input =
            '<svg viewbox="10 10 10 10" width="100"><rect x="37.5" y="7.5" width="675.0" height="16.875" fill="#e05d44" stroke="white" stroke-width="1"><title>/</title></rect></svg>'
        expect(renderCodyMarkdown(input)).toBe('<p></p>')
    })
    it('forbids data URI links', () => {
        const input = '<a href="data:text/plain,foobar" download>D</a>\n[D2](data:text/plain,foobar)'
        expect(renderCodyMarkdown(input)).toBe('<p><a download="">D</a><br><a>D2</a></p>')
    })
})
