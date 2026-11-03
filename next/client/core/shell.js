// `ctx.shell`: the page layout. Plugins put their elements into a region with
// mount(); the element leaves the page when the plugin that mounted it does.

import { Service } from 'cordis';
import { h } from '@twp/client';

export const REGIONS = ['header', 'sidebar', 'main'];

export default class ShellService extends Service {
  constructor(ctx) {
    super(ctx, 'shell');
    this.titleText = h('span', { class: 'shell-title' }, document.title);
    this.statusText = h('span', { class: 'shell-status', role: 'status' });
    this.regions = {
      header: h('div', { class: 'shell-header-items' }),
      sidebar: h('nav', { class: 'shell-sidebar', 'aria-label': '工作区' }),
      main: h('main', { class: 'shell-main' }),
    };
    this.layout = h('div', { class: 'shell' },
      h('header', { class: 'shell-header' }, this.titleText, this.regions.header, this.statusText),
      this.regions.sidebar,
      this.regions.main,
    );
    const app = document.getElementById('app');
    ctx.effect(() => {
      app.replaceChildren(this.layout);
      return () => this.layout.remove();
    }, 'shell.layout');
  }

  /**
   * Puts `element` into a region for the calling plugin. Lower `order` comes
   * first; equal orders keep mounting order.
   */
  mount(region, element, { order = 0 } = {}) {
    const target = this.regions[region];
    if (!target) throw new Error(`unknown shell region "${region}"`);
    return this.ctx.effect(() => {
      element.dataset.shellOrder = String(order);
      const before = [...target.children].find((child) => Number(child.dataset.shellOrder) > order);
      target.insertBefore(element, before ?? null);
      return () => element.remove();
    }, `shell.mount(${region})`);
  }

  /** One line of status in the header; empty clears it. */
  status(text, { tone = 'info' } = {}) {
    this.statusText.textContent = text || '';
    this.statusText.dataset.tone = tone;
  }
}
