'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const configDirectory = process.env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), '.config', 'opencode');

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function mergePlugins(config, pluginPath) {
  const plugins = config.plugins || (Array.isArray(config.plugin) ? config.plugin : []);
  if (!plugins.some(entry => (typeof entry === 'string' ? entry : entry?.package) === pluginPath)) {
    plugins.push(pluginPath);
  }
  if (config.provider) config.plugin = plugins;
  else config.plugins = plugins;
  return config;
}

async function main() {
  const target = process.argv[2] ? path.resolve(process.argv[2]) : configDirectory;
  const global = target === configDirectory;
  const pluginDirectory = global ? path.join(target, 'plugins', 'kimi-local-bridge-memory') : path.join(target, 'plugins', 'kimi-local-bridge-memory');
  await fs.mkdir(pluginDirectory, { recursive: true });
  await fs.copyFile(path.join(root, 'src', 'memory.js'), path.join(pluginDirectory, 'memory.js'));
  await fs.writeFile(path.join(pluginDirectory, 'index.js'), [
    "import { createRequire } from 'node:module';",
    '',
    'const { MemoryPlugin } = createRequire(import.meta.url)(\'./memory.js\');',
    '',
    'export default {',
    "  id: 'kimi-local-bridge-memory',",
    '  server: async context => MemoryPlugin({',
    '    ...context,',
    '    directory: context.directory || context.location?.directory || process.cwd(),',
    '  }),',
    '};',
    '',
  ].join('\n'));
  if (global) {
    const file = path.join(target, 'opencode.json');
    const config = await exists(file) ? JSON.parse(await fs.readFile(file, 'utf8')) : { $schema: 'https://opencode.ai/config.json' };
    const updated = mergePlugins(config, pluginDirectory);
    await fs.writeFile(file, JSON.stringify(updated, null, 2) + '\n');
    console.log(`Enabled Kimi memory globally in ${file}`);
  } else {
    console.log(`Installed the memory plugin in ${pluginDirectory}`);
  }
  console.log('The vault will be created at memory/ in each project you work on.');
  console.log('Restart OpenCode to load or reload the plugin. No NVIDIA session data is stored in memory.');
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
