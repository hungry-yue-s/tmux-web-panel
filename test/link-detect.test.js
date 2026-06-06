import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const src = fs.readFileSync('public/js/link-detect.js', 'utf8');
const sandbox = { window: {} };
new Function('window', src)(sandbox.window);
const LD = sandbox.window.LinkDetect;

const find = (s) => LD.findLinks(s);
const texts = (s) => find(s).map((m) => m.text);
const one = (s) => {
  const ls = find(s);
  expect(ls.length, `expected exactly 1 link in ${JSON.stringify(s)}, got ${JSON.stringify(ls.map((l) => l.text))}`).toBe(1);
  return ls[0];
};

describe('Fix 1 — path:line:col', () => {
  it('bare path with :line:col -> clean text + lineRef', () => {
    const l = one('src/app.js:42:10');
    expect(l.kind).toBe('file');
    expect(l.text).toBe('src/app.js');
    expect(l.lineRef).toBe(42);
  });
  it('absolute path :line', () => {
    const l = one('/home/u/app.py:42');
    expect(l.text).toBe('/home/u/app.py');
    expect(l.lineRef).toBe(42);
  });
  it('D2 python traceback ", line N"', () => {
    const l = one('/home/u/app.py", line 42');
    expect(l.text).toBe('/home/u/app.py');
    expect(l.lineRef).toBe(42);
  });
  it('D1 year glued to extensionless leaf is NOT a line ref', () => {
    const l = one('/var/log/syslog:2024 rotated');
    expect(l.text).toBe('/var/log/syslog');
    expect(l.lineRef).toBe(null);
  });
});

describe('Fix 2 — www / localhost', () => {
  it('www. -> https href', () => {
    const l = one('see www.example.com/x now');
    expect(l.kind).toBe('web');
    expect(l.href).toBe('https://www.example.com/x');
  });
  it('localhost:port -> http href', () => {
    const l = one('listening on localhost:3000');
    expect(l.kind).toBe('web');
    expect(l.href).toBe('http://localhost:3000');
  });
  it('127.0.0.1:port/path', () => {
    const l = one('dev at 127.0.0.1:5173/y');
    expect(l.href).toBe('http://127.0.0.1:5173/y');
  });
  it('D4 no inner www. match inside a word', () => {
    expect(texts('barwww.example.com is one word')).not.toContain('www.example.com');
  });
  it('D5 no inner localhost match inside a word', () => {
    expect(find('use mylocalhost:3000 internally').filter((m) => m.kind === 'web')).toHaveLength(0);
  });
});

describe('Fix 3 — file://', () => {
  it('file:///path', () => {
    const l = one('file:///home/a.md');
    expect(l.kind).toBe('file');
    expect(l.text).toBe('/home/a.md');
  });
  it('file://host/path strips authority', () => {
    expect(one('file://host/p.txt').text).toBe('/p.txt');
  });
  it('percent-decodes', () => {
    expect(one('file:///a%20b/c.txt').text).toBe('/a b/c.txt');
  });
  it('D8 invalid percent does not throw, keeps raw', () => {
    let l;
    expect(() => { l = find('file:///tmp/100%done/log.txt'); }).not.toThrow();
    expect(l.map((m) => m.text)).toContain('/tmp/100%done/log.txt');
  });
  it('D9/D10 empty/host-only -> no link', () => {
    expect(find('file://')).toHaveLength(0);
    expect(find('file:///')).toHaveLength(0);
    expect(find('file://host')).toHaveLength(0);
  });
  it('D7 file:// keeps :line', () => {
    const l = one('file:///home/a.md:42');
    expect(l.text).toBe('/home/a.md');
    expect(l.lineRef).toBe(42);
  });
});

describe('Fix 4 — CJK trailing leak', () => {
  it('strips CJK glued to ascii leaf', () => {
    expect(one('打开/etc/hosts看看').text).toBe('/etc/hosts');
  });
  it('preserves pure-CJK leaf', () => {
    expect(one('~/文档/笔记').text).toBe('~/文档/笔记');
  });
});

describe('Fix 5 — Chinese in URL', () => {
  it('wikipedia path', () => {
    expect(one('https://zh.wikipedia.org/wiki/中文').text).toBe('https://zh.wikipedia.org/wiki/中文');
  });
  it('query param', () => {
    expect(one('https://baidu.com/s?wd=关键词').text).toBe('https://baidu.com/s?wd=关键词');
  });
  it('fullwidth comma bounds URL', () => {
    expect(one('见 https://x.com/a，后面').text).toBe('https://x.com/a');
  });
  it('D15 does NOT corrupt trailing CJK in a query value', () => {
    expect(one('https://s.com/q?w=中文1页').text).toBe('https://s.com/q?w=中文1页');
  });
  it('trims glued Chinese prose after a bare domain', () => {
    expect(one('clone https://github.com然后克隆 now').text).toBe('https://github.com');
  });
  it('trims glued Chinese prose after a path file', () => {
    expect(one('see https://x.com/路径/foo.md然后继续 ok').text).toBe('https://x.com/路径/foo.md');
  });
  it('keeps a pure-CJK path segment (no trim)', () => {
    expect(one('https://zh.wikipedia.org/wiki/中文').text).toBe('https://zh.wikipedia.org/wiki/中文');
  });
});

describe('Fix 6 — bare Chinese filenames', () => {
  it('报告.pdf', () => {
    const l = one('报告.pdf');
    expect(l.kind).toBe('file');
    expect(l.text).toBe('报告.pdf');
  });
  it('D17 报告.pdf和笔记.txt -> two links', () => {
    expect(texts('报告.pdf和笔记.txt').sort()).toEqual(['报告.pdf', '笔记.txt'].sort());
  });
  it('version/IP not a file', () => {
    expect(find('1.0.0')).toHaveLength(0);
    expect(find('192.168.1.1')).toHaveLength(0);
  });
});

describe('ambiguous web/file (user rule: let user choose)', () => {
  it('example.com -> ambiguous', () => {
    const l = one('example.com');
    expect(l.kind).toBe('ambiguous');
    expect(l.href).toBe('https://example.com');
  });
  it('report.pdf -> file (pdf is not a TLD)', () => {
    expect(one('report.pdf').kind).toBe('file');
  });
  it('app.py -> file (py is a known code ext)', () => {
    expect(one('app.py').kind).toBe('file');
  });
});

describe('Fix 7 — Chinese punctuation boundaries', () => {
  it('D21 bracketed home path is ONE link', () => {
    expect(one('「~/文档/a.md」').text).toBe('~/文档/a.md');
  });
  it('trailing fullwidth period', () => {
    expect(one('路径是~/a.md。').text).toBe('~/a.md');
  });
  it('url before fullwidth period', () => {
    expect(one('见https://x.com/a。').text).toBe('https://x.com/a');
  });
});

describe('Fix 8 — label-prefixed paths', () => {
  it('the headline user case', () => {
    const l = one('📄 已生成:docs/FN-block-db-defect-audit-2026-06-03.md');
    expect(l.kind).toBe('file');
    expect(l.text).toBe('docs/FN-block-db-defect-audit-2026-06-03.md');
  });
  it('Created:src/foo.js', () => {
    expect(one('Created:src/foo.js').text).toBe('src/foo.js');
  });
  it('D25 Output:/var/log/x (absolute)', () => {
    expect(one('Output:/var/log/x').text).toBe('/var/log/x');
  });
  it('D26 写入:./build/out.js (relative)', () => {
    expect(one('写入:./build/out.js').text).toBe('./build/out.js');
  });
  it('D24 已保存:报告.pdf is ONE link', () => {
    expect(one('已保存:报告.pdf').text).toBe('报告.pdf');
  });
  it('D27 scp user@host:path is NOT a local path', () => {
    expect(find('git@host:rel/path').filter((m) => m.kind === 'file')).toHaveLength(0);
  });
  it('localhost:3000/path stays a web link', () => {
    const l = one('localhost:3000/path');
    expect(l.kind).toBe('web');
    expect(l.href).toBe('http://localhost:3000/path');
  });
  it('time 12:34 and ratio 3:4/scale -> no link', () => {
    expect(find('at time 12:34 done')).toHaveLength(0);
    expect(find('ratio 3:4/scale')).toHaveLength(0);
  });
});

describe('Fix 10 — shouldJoinHardWrap (guarded)', () => {
  it('joins full URL row ending / with bare continuation', () => {
    expect(LD.shouldJoinHardWrap('https://example.com/a/b/c/d/', true, 'h/i.html')).toBe(true);
  });
  it('does not join non-full prev row', () => {
    expect(LD.shouldJoinHardWrap('https://example.com/a/', false, 'h/i.html')).toBe(false);
  });
  it('does not join indented continuation', () => {
    expect(LD.shouldJoinHardWrap('https://example.com/a/', true, '    foo')).toBe(false);
  });
  it('D31 does not join CJK-leading continuation', () => {
    expect(LD.shouldJoinHardWrap('https://example.com/wiki/page/', true, '中文说明在这里')).toBe(false);
  });
  it('does not join when prev ends with a letter', () => {
    expect(LD.shouldJoinHardWrap('https://example.com/page', true, 'more')).toBe(false);
  });
  it('D33 path seam ending = does not join (= is not a path open-token)', () => {
    expect(LD.shouldJoinHardWrap('/opt/app/config=base', true, 'name.conf')).toBe(false);
  });
});

describe('false-positive policy (conservative)', () => {
  it('D41 numeric slash tuples rejected', () => {
    expect(find('2024/06/05')).toHaveLength(0);
    expect(find('3/4')).toHaveLength(0);
    expect(find('100/200')).toHaveLength(0);
  });
  it('D42 pure-CJK slash prose -> no /后端', () => {
    expect(find('前端/后端 分离')).toHaveLength(0);
  });
  it('prose slash pairs are LEFT matching (no aggressive trim)', () => {
    expect(texts('read/write access')).toContain('read/write');
  });
});

describe('URL regression (old-addon parity)', () => {
  it('trailing period stripped', () => {
    expect(one('see https://a.com.').text).toBe('https://a.com');
  });
  it('parens excluded', () => {
    expect(one('(https://a.com/x)').text).toBe('https://a.com/x');
  });
  it('D36 keeps trailing ; and #', () => {
    expect(one('url:https://a.com;next').text).toBe('https://a.com;next');
  });
  it('full http url with query/fragment', () => {
    expect(one('http://a.com:8080/p/q?x=1&y=2#frag').text).toBe('http://a.com:8080/p/q?x=1&y=2#frag');
  });
});
