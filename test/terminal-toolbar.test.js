import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const terminalSource = readFileSync('public/js/terminal.js', 'utf8');
const styles = readFileSync('public/css/style.css', 'utf8');

describe('terminal toolbar controls', () => {
  it('uses accessible SVG controls for the terminal header actions', () => {
    expect(terminalSource).toContain('function _terminalToolIcon(paths)');
    expect(terminalSource).toContain('class="terminal-tool-icon"');

    ['返回窗口列表', '刷新终端', '标签页模式', '分屏模式', '减小字号',
      '增大字号', '新增分屏', '设置当前窗格标签', '从 tmux 缓冲区打开文件',
      '在新窗口打开', '全屏'].forEach((label) => {
      expect(terminalSource).toContain(`aria-label="${label}"`);
    });
  });

  it('exposes pressed state for the tab and split mode toggle', () => {
    expect(terminalSource).toContain('aria-pressed="\' + (_terminalMode === \'tab\' ? \'true\' : \'false\')');
    expect(terminalSource).toContain('aria-pressed="\' + (_terminalMode === \'split\' ? \'true\' : \'false\')');
  });

  it('keeps desktop controls uniform and theme driven', () => {
    expect(styles).toMatch(/\.terminal-tool-btn[\s\S]*?width:\s*32px[\s\S]*?height:\s*32px/);
    expect(styles).toContain('background: color-mix(in srgb, var(--accent-blue) 14%, transparent);');
    expect(styles).toContain('.terminal-tool-icon');
  });
});
