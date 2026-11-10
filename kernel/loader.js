// The loader mounts the entries of an assembled profile, in order, as children
// of its own fiber. Disposing the loader therefore disposes the whole
// application, and every effect a plugin registered is undone with it.
//
// It is itself a service (`ctx.loader`), so a plugin can list the entries or
// turn one off and on at runtime. Turning an entry off disposes its fiber:
// routes, timers, listeners and provided services go with it.

import { FiberState, Service } from 'cordis';

function stateName(fiber) {
  if (!fiber) return 'off';
  return String(FiberState[fiber.state] ?? fiber.state).toLowerCase();
}

export class Loader extends Service {
  /**
   * @param {import('cordis').Context} ctx
   * @param {{ entries: Array<{ id: string, use: string, module: string, config: any, disabled: boolean }>,
   *           importer?: (specifier: string) => Promise<any> }} config
   */
  constructor(ctx, config) {
    super(ctx, 'loader');
    // Service methods see the caller's ctx as `this.ctx`; plugins are mounted
    // on the loader's own context, whoever asks.
    this.home = ctx;
    this.entries = config.entries.map((entry) => ({ ...entry }));
    this.importer = config.importer ?? ((specifier) => import(specifier));
    this.fibers = new Map();
    this.failures = new Map();
  }

  async [Service.init]() {
    for (const entry of this.entries) {
      if (!entry.disabled) await this._mount(entry);
    }
  }

  async _mount(entry) {
    this.failures.delete(entry.id);
    let plugin;
    try {
      const mod = await this.importer(entry.module);
      plugin = mod.default ?? mod;
    } catch (error) {
      this.failures.set(entry.id, error);
      this.home.logger('loader').error('cannot import "%s" (%s): %s', entry.id, entry.use, error?.message ?? error);
      return;
    }
    let fiber;
    try {
      fiber = this.home.plugin(plugin, entry.config ?? undefined);
    } catch (error) {
      this.failures.set(entry.id, error);
      this.home.logger('loader').error('cannot mount "%s": %s', entry.id, error?.message ?? error);
      return;
    }
    this.fibers.set(entry.id, fiber);
    try {
      await fiber;
    } catch (error) {
      // The fiber has logged it; remember it for status() and the launcher.
      this.failures.set(entry.id, error);
    }
  }

  /** Every entry with its current state: off, pending, loading, active, failed, … */
  status() {
    return this.entries.map((entry) => {
      const fiber = this.fibers.get(entry.id);
      const failure = this.failures.get(entry.id);
      return {
        id: entry.id,
        use: entry.use,
        disabled: entry.disabled,
        state: failure && !fiber ? 'failed' : stateName(fiber),
        error: failure ? String(failure?.message ?? failure) : null,
      };
    });
  }

  /**
   * The ids of the entries running now. Pages (window.PANEL_PLUGINS) and a
   * node's info (node.plugins) both report this, and PanelSlots.hasPlugin
   * reads either, so they must mean the same thing.
   */
  activeIds() {
    return this.status().filter((entry) => entry.state === 'active').map((entry) => entry.id);
  }

  /** Turns an entry off (disposing everything it registered) or back on. */
  async setDisabled(id, disabled) {
    const entry = this.entries.find((item) => item.id === id);
    if (!entry) throw new Error(`no entry "${id}"`);
    entry.disabled = disabled;
    const fiber = this.fibers.get(id);
    if (disabled) {
      this.fibers.delete(id);
      this.failures.delete(id);
      if (fiber) await fiber.dispose();
      return;
    }
    if (!fiber) await this._mount(entry);
  }
}
