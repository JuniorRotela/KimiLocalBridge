import { createRequire } from 'node:module';

const { MemoryPlugin } = createRequire(import.meta.url)('../../src/memory.js');

export default {
  id: 'kimi-local-bridge-memory',
  server: async context => MemoryPlugin({
    ...context,
    directory: context.directory || context.location?.directory || process.cwd(),
  }),
};
