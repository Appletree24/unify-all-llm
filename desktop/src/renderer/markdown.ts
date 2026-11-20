import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import markdown from 'highlight.js/lib/languages/markdown';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { Marked } from 'marked';

const languages = { bash, c, cpp, csharp, css, diff, go, java, javascript, json, kotlin, markdown, powershell, python, rust, sql, swift, typescript, xml, yaml };
for (const [name, lang] of Object.entries(languages)) hljs.registerLanguage(name, lang);
hljs.registerAliases(['sh', 'shell', 'zsh', 'console'], { languageName: 'bash' });
hljs.registerAliases(['js', 'jsx', 'mjs', 'cjs'], { languageName: 'javascript' });
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' });
hljs.registerAliases(['html', 'svg', 'vue'], { languageName: 'xml' });
hljs.registerAliases(['py'], { languageName: 'python' });
hljs.registerAliases(['rs'], { languageName: 'rust' });
hljs.registerAliases(['yml'], { languageName: 'yaml' });
hljs.registerAliases(['ps1', 'pwsh'], { languageName: 'powershell' });
hljs.registerAliases(['md'], { languageName: 'markdown' });

const escape = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const marked = new Marked({
  gfm: true,
  renderer: {
    code({ text, lang }) {
      const name = (lang ?? '').trim().split(/\s+/)[0].toLowerCase();
      const known = name && hljs.getLanguage(name);
      const body = known ? hljs.highlight(text, { language: name, ignoreIllegals: true }).value : escape(text);
      return `<div class="code"><div class="code-head"><span>${escape(name || 'text')}</span><button type="button" class="code-copy">复制</button></div><pre><code class="hljs">${body}</code></pre></div>`;
    },
  },
});

/** Model output is untrusted: render Markdown, then sanitize before it touches the DOM. */
export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false });
  return DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'form', 'input', 'iframe'], FORBID_ATTR: ['style'] });
}
