/**
 * Barrel for the provider-neutral `electron/shared` contract.
 *
 * Importable from both the Electron main process and the renderer — keep this
 * module free of any Electron or project-local dependency.
 */
export * from './events.js';
