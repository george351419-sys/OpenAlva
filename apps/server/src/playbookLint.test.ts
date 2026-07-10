import { describe, expect, it } from 'vitest';
import { lintPlaybookHtml } from './playbookLint.js';

const BASE_HEAD =
  '<link rel="stylesheet" href="/design-system/v1/design-system.css">' +
  '<style>html{-webkit-font-smoothing: antialiased;-moz-osx-font-smoothing: grayscale;text-rendering: optimizeLegibility;}</style>';

function page(body: string, head = BASE_HEAD): string {
  return `<!doctype html><html><head>${head}</head><body><div class="playbook-container">${body}</div></body></html>`;
}

function rulesOf(html: string): string[] {
  return lintPlaybookHtml(html).violations.map((v) => v.rule);
}

describe('playbookLint（design-contract 全局规则）', () => {
  it('合规最小页面通过', () => {
    expect(lintPlaybookHtml(page('<h1>ok</h1>'))).toEqual({ pass: true, violations: [] });
  });

  it('required-container：缺 playbook-container 拦截', () => {
    const html = `<!doctype html><html><head>${BASE_HEAD}</head><body><main>x</main></body></html>`;
    expect(rulesOf(html)).toContain('required-container');
  });

  it('required-stylesheets：缺设计系统样式表拦截；带查询串/大写属性放行', () => {
    const noCss = `<!doctype html><html><head><style>html{-webkit-font-smoothing: antialiased;-moz-osx-font-smoothing: grayscale;text-rendering: optimizeLegibility;}</style></head><body><div class="playbook-container">x</div></body></html>`;
    expect(rulesOf(noCss)).toContain('required-stylesheets');

    const queryString = page('<p>x</p>').replace(
      'design-system.css',
      'design-system.css?v=2',
    );
    expect(rulesOf(queryString)).not.toContain('required-stylesheets');

    const upper = page('<p>x</p>').replace('<link rel=', '<LINK REL=');
    expect(rulesOf(upper)).not.toContain('required-stylesheets');
  });

  it('links：缺 target/rel 拦截；合规与页内锚点放行', () => {
    expect(rulesOf(page('<a href="https://x.test">out</a>'))).toContain('links');
    expect(rulesOf(page('<a href="https://x.test" target="_blank" rel="noopener">out</a>'))).toContain(
      'links', // rel 缺 noreferrer
    );
    expect(
      rulesOf(page('<a href="https://x.test" target="_blank" rel="noopener noreferrer">out</a>')),
    ).not.toContain('links');
    expect(rulesOf(page('<a href="#section">jump</a>'))).not.toContain('links');
  });

  it('typography：字重只允许 400/500（style 块与 inline 双路）', () => {
    expect(rulesOf(page('<style>h1{font-weight:700}</style>'))).toContain('typography');
    expect(rulesOf(page('<span style="font-weight: bold">x</span>'))).toContain('typography');
    expect(rulesOf(page('<style>h1{font-weight:500}p{font-weight:400}</style>'))).not.toContain(
      'typography',
    );
  });

  it('scroll：唯一滚动容器 body/html；其他选择器与 inline overflow 拦截', () => {
    expect(rulesOf(page('<style>.panel{overflow:auto}</style>'))).toContain('scroll');
    expect(rulesOf(page('<style>.a,.b{overflow-y:scroll}</style>'))).toContain('scroll');
    expect(rulesOf(page('<div style="overflow: scroll">x</div>'))).toContain('scroll');
    expect(rulesOf(page('<style>body{overflow:auto}</style>'))).not.toContain('scroll');
    expect(rulesOf(page('<style>html, body{overflow-y:auto}</style>'))).not.toContain('scroll');
    expect(rulesOf(page('<style>.panel{overflow:hidden}</style>'))).not.toContain('scroll');
  });

  it('anti-aliasing：三条声明缺一即拦截', () => {
    const headMissing =
      '<link rel="stylesheet" href="/design-system/v1/design-system.css">' +
      '<style>html{-webkit-font-smoothing: antialiased;}</style>';
    const rules = rulesOf(page('<p>x</p>', headMissing));
    expect(rules.filter((r) => r === 'anti-aliasing')).toHaveLength(2);
  });

  it('required-scripts：echarts.init 必须配 requestAnimationFrame', () => {
    expect(rulesOf(page('<script>echarts.init(el).setOption({})</script>'))).toContain(
      'required-scripts',
    );
    expect(
      rulesOf(page('<script>requestAnimationFrame(() => echarts.init(el))</script>')),
    ).not.toContain('required-scripts');
  });
});
