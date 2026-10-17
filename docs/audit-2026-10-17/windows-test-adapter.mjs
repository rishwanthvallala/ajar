// Environment adapter only: the checked-in browser test assertions are unchanged.
// Windows has Edge and python.exe, but not the exact bundled Chromium build
// or a working python3.exe executable.
import { chromium } from '../../node_modules/playwright/index.mjs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const launch = chromium.launch.bind(chromium);
chromium.launch = options => launch({ ...options, channel: 'msedge' });
const persistent = chromium.launchPersistentContext.bind(chromium);
chromium.launchPersistentContext = (profile, options) => persistent(profile, { ...options, channel: 'msedge' });
const execFileSync = childProcess.execFileSync;
childProcess.execFileSync = (file, ...args) => execFileSync(file === 'python3' ? 'C:/Python311/python.exe' : file, ...args);
syncBuiltinESMExports();
