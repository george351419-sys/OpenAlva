/**
 * Playbook HTML 静态 lint —— vendor/design-system/design-contract.yaml
 * 核心全局规则的移植子集（容器/样式表/滚动/字重/链接/抗锯齿/ECharts）。
 * 静态字符串级检查，不建 DOM：作为 release 门禁足够，组件级 registry
 * 校验（btn/tag/select…）留给后续需要时再补。
 */

export interface LintViolation {
  rule: string;
  message: string;
}

export interface LintResult {
  pass: boolean;
  violations: LintViolation[];
}

export function lintPlaybookHtml(html: string): LintResult {
  const violations: LintViolation[] = [];
  const add = (rule: string, message: string): void => {
    violations.push({ rule, message });
  };

  // required-container: .playbook-container 必须存在
  if (!/class\s*=\s*["'][^"']*\bplaybook-container\b/i.test(html)) {
    add(
      'required-container',
      'Missing required container: an element with class "playbook-container" must exist.',
    );
  }

  // required-stylesheets: 必须引官方 design-system/design-tokens css（CDN 或本地同形 URL，
  // 允许 ?v= 之类查询串）
  if (!/<link[^>]+href\s*=\s*["'][^"']*design-(system|tokens)\.css[^"']*["']/i.test(html)) {
    add(
      'required-stylesheets',
      'Missing design system stylesheet: link /design-system/v1/design-system.css (or the official CDN URL).',
    );
  }

  // links: 所有 <a> 必须带 target 且 rel 含 noopener noreferrer
  for (const tag of html.match(/<a\b[^>]*>/gi) ?? []) {
    if (/href\s*=\s*["']#/.test(tag)) continue; // 页内锚点豁免
    const missing: string[] = [];
    if (!/\btarget\s*=/.test(tag)) missing.push('target');
    const rel = /\brel\s*=\s*["']([^"']*)["']/.exec(tag)?.[1] ?? '';
    if (!rel.includes('noopener') || !rel.includes('noreferrer')) {
      missing.push('rel="noopener noreferrer"');
    }
    if (missing.length > 0) {
      add('links', `Anchor missing ${missing.join(' and ')}: ${tag.slice(0, 120)}`);
    }
  }

  const cssBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1] ?? '');
  const inlineStyles = [...html.matchAll(/style\s*=\s*["']([^"']*)["']/gi)].map((m) => m[1] ?? '');

  // typography: font-weight 只允许 400/500（bold=700 同罪）
  for (const css of [...cssBlocks, ...inlineStyles]) {
    for (const m of css.matchAll(/font-weight\s*:\s*([^;}"']+)/gi)) {
      const value = (m[1] ?? '').trim().toLowerCase();
      if (value === 'normal' || value === 'inherit' || value === '400' || value === '500') continue;
      add('typography', `font-weight "${value}" is not allowed (only 400/500).`);
    }
  }

  // scroll: 唯一滚动容器是 body/html —— 其他选择器不得 overflow auto/scroll
  for (const css of cssBlocks) {
    for (const rule of css.split('}')) {
      const [selectorPart, declPart] = [
        rule.slice(0, rule.indexOf('{')),
        rule.slice(rule.indexOf('{') + 1),
      ];
      if (!declPart || !/overflow(-[xy])?\s*:\s*(auto|scroll)/i.test(declPart)) continue;
      const selector = (selectorPart ?? '').trim();
      const soleScroll = selector
        .split(',')
        .every((s) => ['body', 'html'].includes(s.trim().toLowerCase()));
      if (!soleScroll) {
        add(
          'scroll',
          `Only body/html may scroll; found overflow auto/scroll on selector "${selector.slice(0, 80)}".`,
        );
      }
    }
  }
  for (const style of inlineStyles) {
    if (/overflow(-[xy])?\s*:\s*(auto|scroll)/i.test(style)) {
      add('scroll', `Inline overflow auto/scroll is not allowed: style="${style.slice(0, 80)}"`);
    }
  }

  // anti-aliasing: 三条声明必须出现（design.md §Typography）
  const allCss = cssBlocks.join('\n');
  for (const decl of [
    '-webkit-font-smoothing: antialiased',
    '-moz-osx-font-smoothing: grayscale',
    'text-rendering: optimizeLegibility',
  ]) {
    const [prop, value] = decl.split(':').map((s) => s.trim());
    const re = new RegExp(`${prop}\\s*:\\s*${value}`, 'i');
    if (!re.test(allCss)) {
      add('anti-aliasing', `Missing required declaration: ${decl}`);
    }
  }

  // ECharts 必须经 requestAnimationFrame 延迟 init/resize
  if (html.includes('echarts.init') && !html.includes('requestAnimationFrame')) {
    add(
      'required-scripts',
      'Pages using echarts.init must defer init/resize via requestAnimationFrame (0-width container at first render compresses the canvas).',
    );
  }

  return { pass: violations.length === 0, violations };
}
