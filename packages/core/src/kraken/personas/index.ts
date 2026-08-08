/**
 * Kraken personas — public surface.
 *
 * Importing this module registers all built-in personas with the
 * registry. Side-effect import: `import '@zelari/kraken/personas'`.
 *
 * @since Kraken v1.30.x — workflow script runtime (Pillar 2)
 */

import './specReviewer.js';
import './conformance.js';

export * from './registry.js';
