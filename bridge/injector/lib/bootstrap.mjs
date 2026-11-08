// CDP expressions used to inject and drive the shell hook.
//
// Everything here is a pure string builder so the self-test can validate escaping
// and syntax without launching DSH (compile with `new Function(expr)`).

/**
 * Build the one-shot bootstrap expression evaluated in the Electron main process.
 *
 * The evaluation context has NO global `require` and dynamic `import()` fails
 * (verified on Electron 44 / DSH Desktop 0.2.2-rc.1), but
 * `process.mainModule.require` works, so it is the only door into `electron`.
 * The hook source is embedded (JSON-escaped) and wrapped in a CJS module shim;
 * a custom `require` resolves the hook's relative `lib/*.cjs` requires against
 * `hookDir` and forwards everything else to the main-module require.
 *
 * @param {object} options
 * @param {string} options.hookSource contents of bridge/shell-hook/hook.cjs
 * @param {string} options.hookPath absolute path of hook.cjs (diagnostics only)
 * @param {string} options.hookDir directory containing hook.cjs and lib/
 * @param {string} options.dataDir bridge state/log directory
 * @param {string} [options.version]
 */
export function buildBootstrapExpression(options = {}) {
  const hookSource = options.hookSource
  if (typeof hookSource !== 'string' || hookSource === '') {
    throw new Error('buildBootstrapExpression: hookSource is required')
  }
  const literals = {
    hookPath: JSON.stringify(String(options.hookPath || '')),
    hookDir: JSON.stringify(String(options.hookDir || '')),
    dataDir: JSON.stringify(String(options.dataDir || '')),
    version: JSON.stringify(String(options.version || ''))
  }
  const sourceLiteral = JSON.stringify(hookSource)
  return `(() => {
  try {
    const main = process.mainModule;
    if (!main || typeof main.require !== 'function') return { ok: false, error: 'process.mainModule.require is unavailable' };
    const req = main.require.bind(main);
    const path = req('node:path');
    const hookPath = ${literals.hookPath};
    const hookDir = ${literals.hookDir};
    const dataDir = ${literals.dataDir};
    const version = ${literals.version};
    const source = ${sourceLiteral};
    const api = req('electron');
    const hookRequire = (id) => {
      if (typeof id !== 'string') throw new TypeError('hook require expects a string');
      if (id === 'electron') return api;
      if (id.charAt(0) === '.' || path.isAbsolute(id)) return req(path.resolve(hookDir, id));
      return req(id);
    };
    const module = { exports: {} };
    const wrapper = new Function('module', 'exports', 'require', 'process', '__filename', '__dirname', source);
    wrapper(module, module.exports, hookRequire, process, hookPath, hookDir);
    if (!module.exports || typeof module.exports.start !== 'function') {
      return { ok: false, error: 'hook module does not export start()' };
    }
    const handle = module.exports.start({ api, env: process.env, dataDir, hookDir, version });
    globalThis.__DSHTF = handle;
    let diagnostics = null;
    try { diagnostics = handle && typeof handle.diagnostics === 'function' ? handle.diagnostics() : null; } catch (_error) { diagnostics = null; }
    return {
      ok: !!handle,
      handleType: typeof handle,
      appReady: diagnostics ? diagnostics.appReady === true : null,
      patched: diagnostics ? diagnostics.patched === true : null
    };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error), stack: String((error && error.stack) || '') };
  }
})()`
}

/** Expression returning `globalThis.__DSHTF.diagnostics()`. */
export function buildDiagnosticsExpression() {
  return `(() => {
  try {
    return globalThis.__DSHTF && typeof globalThis.__DSHTF.diagnostics === 'function'
      ? globalThis.__DSHTF.diagnostics()
      : { ok: false, error: 'globalThis.__DSHTF is not a bridge handle' };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
})()`
}

/** Function declaration used with Runtime.callFunctionOn to adopt a Tray object. */
export const ADOPT_FUNCTION_DECLARATION = `function () {
  try {
    return globalThis.__DSHTF && typeof globalThis.__DSHTF.adopt === 'function'
      ? globalThis.__DSHTF.adopt(this)
      : { adopted: false, error: 'globalThis.__DSHTF is not a bridge handle' };
  } catch (error) {
    return { adopted: false, error: String((error && error.message) || error) };
  }
}`

/** Expression asking the hook to close the inspector (or keep it in test mode). */
export function buildFinalizeExpression(options = {}) {
  const keep = options.keepInspector === true
  return `(() => {
  try {
    if (!globalThis.__DSHTF || typeof globalThis.__DSHTF.finalize !== 'function') return { closed: false, error: 'globalThis.__DSHTF is not a bridge handle' };
    return globalThis.__DSHTF.finalize(${JSON.stringify({ keepInspector: keep })});
  } catch (error) {
    return { closed: false, error: String((error && error.message) || error) };
  }
})()`
}

/** Expression that quits the target Electron app through its own API. */
export function buildQuitExpression() {
  return `(() => {
  try {
    const api = process.mainModule.require('electron');
    api.app.exit(0);
    return { ok: true, action: 'app.exit(0)' };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
})()`
}
