// Restore Windows-friendly generated links after installing lockfile packages in WSL.
// Only generated node_modules links/shims are touched; package sources and lockfiles are untouched.
const fs = require('node:fs');
const path = require('node:path');
const cmdShim = require('D:/Nodejs/node_modules/npm/node_modules/cmd-shim');
const root = path.resolve(__dirname, '../..');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
(async () => {
  for (const [relative, entry] of Object.entries(lock.packages)) {
    if (!relative.includes('node_modules/')) continue;
    const packageDir = path.resolve(root, relative);
    if (!packageDir.startsWith(root + path.sep)) throw Error('outside workspace');
    if (entry.link) {
      const target = path.resolve(root, entry.resolved);
      if (!target.startsWith(root + path.sep)) throw Error('outside workspace target');
      let current;
      try { current = fs.lstatSync(packageDir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (current && !current.isSymbolicLink()) throw Error(`not a generated symlink: ${packageDir}`);
      if (current) fs.unlinkSync(packageDir);
      fs.symlinkSync(target, packageDir, 'junction');
      console.log(`junction ${relative}`);
      continue;
    }
    const file = path.join(packageDir, 'package.json');
    if (!fs.existsSync(file)) continue;
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    const bins = typeof pkg.bin === 'string' ? { [pkg.name.replace(/^@.*\//, '')]: pkg.bin } : (pkg.bin || {});
    const modules = packageDir.slice(0, packageDir.lastIndexOf(path.sep + 'node_modules' + path.sep) + '/node_modules'.length);
    for (const [name, source] of Object.entries(bins)) {
      const dest = path.join(modules, '.bin', name);
      try { if (fs.lstatSync(dest).isSymbolicLink()) fs.unlinkSync(dest); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await cmdShim(path.resolve(packageDir, source), dest);
      console.log(`shim ${name}`);
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
