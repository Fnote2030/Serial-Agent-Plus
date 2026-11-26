#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const packageDir = path.resolve(__dirname, '..');
const distDir = path.join(packageDir, 'dist');
const packageJsonPath = path.join(packageDir, 'package.json');

const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const binName = typeof pkg.bin === 'string'
  ? path.basename(pkg.bin, path.extname(pkg.bin))
  : Object.keys(pkg.bin || {})[0] || pkg.name.split('/').pop() || 'serialagent-plus-mcp';
const version = pkg.version;
const versionedBaseName = `${binName}-${version}`;
const versionedEntryName = `${versionedBaseName}.js`;
const versionedMapName = `${versionedBaseName}.js.map`;
const versionedEntryPath = path.join(distDir, versionedEntryName);
const versionedMapPath = path.join(distDir, versionedMapName);
const compatibilityEntryPath = path.join(distDir, 'index.js');

if (!fs.existsSync(compatibilityEntryPath)) {
  throw new Error(`Expected compiled entry at ${compatibilityEntryPath}`);
}

for (const fileName of fs.readdirSync(distDir)) {
  if (/^serialagent-plus-mcp-.*\.js(\.map)?$/.test(fileName)) {
    fs.unlinkSync(path.join(distDir, fileName));
  }
}

let compiledSource = fs.readFileSync(compatibilityEntryPath, 'utf8');
if (compiledSource.includes('//# sourceMappingURL=index.js.map')) {
  compiledSource = compiledSource.replace(
    '//# sourceMappingURL=index.js.map',
    `//# sourceMappingURL=${versionedMapName}`,
  );
}
fs.writeFileSync(versionedEntryPath, compiledSource, 'utf8');

const sourceMapPath = path.join(distDir, 'index.js.map');
if (fs.existsSync(sourceMapPath)) {
  fs.copyFileSync(sourceMapPath, versionedMapPath);
  fs.unlinkSync(sourceMapPath);
}

// Compatibility entry: bin/main starts the server directly.
// Simply requiring the bundle never runs main() because inside the bundle
// require.main !== module (silent no-op exit on global install / npx).
// Hand the "main module" identity to the bundle, then require it.
const compatibilitySource = `#!/usr/bin/env node

// Mark the direct-run scenario for the bundle's autostart check
// (see scripts/postbuild-versioned.cjs). Library imports do not set this,
// so requiring the package from other code never starts the server.
process.env.SERIALAGENT_PLUS_MCP_AUTOSTART = '1';
module.exports = require('./${versionedEntryName}');
`;
fs.writeFileSync(compatibilityEntryPath, compatibilitySource, 'utf8');
