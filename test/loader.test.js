import { Context, Service } from 'cordis';
import { describe, expect, it } from 'vitest';
import { Loader } from '../kernel/loader.js';

function entry(id, extra = {}) {
  return { id, use: id, module: id, config: null, disabled: false, ...extra };
}

function makeImporter(modules) {
  return async (specifier) => {
    if (!(specifier in modules)) throw new Error(`Cannot find module '${specifier}'`);
    return modules[specifier];
  };
}

async function start(entries, modules) {
  const ctx = new Context();
  const fiber = ctx.plugin(Loader, { entries, importer: makeImporter(modules) });
  await fiber;
  return { ctx, fiber, loader: ctx.get('loader') };
}

describe('Loader', () => {
  it('mounts entries in order, passes config, and disposes everything with the loader', async () => {
    const log = [];
    const plugin = (tag) => ({
      default: {
        name: tag,
        apply(ctx, config) {
          log.push(`up ${tag} ${JSON.stringify(config)}`);
          ctx.effect(() => () => log.push(`down ${tag}`));
        },
      },
    });
    const { fiber, loader } = await start(
      [entry('a', { config: { n: 1 } }), entry('b')],
      { a: plugin('a'), b: plugin('b') },
    );
    expect(log).toEqual(['up a {"n":1}', 'up b undefined']);
    expect(loader.status().map((item) => item.state)).toEqual(['active', 'active']);
    await fiber.dispose();
    expect(log.slice(2).sort()).toEqual(['down a', 'down b']);
  });

  it('waits for an injected service no matter the entry order', async () => {
    class Greeter extends Service {
      constructor(ctx) {
        super(ctx, 'greeter');
      }
      hello() { return 'hi'; }
    }
    let heard = null;
    const consumer = { default: { name: 'consumer', inject: ['greeter'], apply(ctx) { heard = ctx.greeter.hello(); } } };
    const { loader } = await start([entry('consumer'), entry('greeter')], { consumer, greeter: { default: Greeter } });
    expect(heard).toBe('hi');
    expect(loader.status().every((item) => item.state === 'active')).toBe(true);
  });

  it('reports a missing provider as pending, and import or apply failures as failed', async () => {
    const waiting = { default: { name: 'waiting', inject: ['nobody'], apply() {} } };
    const broken = { default: { name: 'broken', apply() { throw new Error('boom'); } } };
    const { loader } = await start(
      [entry('waiting'), entry('broken'), entry('missing')],
      { waiting, broken },
    );
    const status = Object.fromEntries(loader.status().map((item) => [item.id, item]));
    expect(status.waiting.state).toBe('pending');
    expect(status.broken.state).toBe('failed');
    expect(status.broken.error).toMatch(/boom/);
    expect(status.missing.state).toBe('failed');
    expect(status.missing.error).toMatch(/Cannot find module/);
    // Only running entries count as there for the pages.
    expect(loader.activeIds()).toEqual([]);
  });

  it('turns an entry off and on at runtime, undoing what it registered', async () => {
    let alive = 0;
    const counter = { default: { name: 'counter', apply(ctx) { alive += 1; ctx.effect(() => () => { alive -= 1; }); } } };
    const { loader } = await start([entry('counter')], { counter });
    expect(alive).toBe(1);
    await loader.setDisabled('counter', true);
    expect(alive).toBe(0);
    expect(loader.status()[0]).toMatchObject({ disabled: true, state: 'off' });
    expect(loader.activeIds()).toEqual([]);
    await loader.setDisabled('counter', false);
    expect(alive).toBe(1);
    expect(loader.activeIds()).toEqual(['counter']);
  });

  it('does not mount a disabled entry', async () => {
    let mounted = false;
    const { loader } = await start([entry('x', { disabled: true })], { x: { default: { name: 'x', apply() { mounted = true; } } } });
    expect(mounted).toBe(false);
    expect(loader.status()[0].state).toBe('off');
  });
});
