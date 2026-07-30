/**
 * Production API boundary for the canonical browser/server protocol module.
 *
 * The package import resolves to the declarations and JavaScript emitted by
 * tsconfig.contracts.json, so API source never reaches into the browser tree.
 */
export * from '#multiplayer-contracts';
export * from '#multiplayer-messages';
