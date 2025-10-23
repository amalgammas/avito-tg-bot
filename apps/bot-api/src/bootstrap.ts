import { join } from 'path';

const Module = require('module');
const originalResolveFilename = Module._resolveFilename.bind(Module);

Module._resolveFilename = function (request: string, parent: NodeModule, isMain: boolean, options: any) {
  if (request.startsWith('@bot/')) {
    const mapped = join(__dirname, request.replace('@bot/', ''));
    return originalResolveFilename(mapped, parent, isMain, options);
  }
  return originalResolveFilename(request, parent, isMain, options);
};

if (typeof global.crypto === 'undefined') {
  global.crypto = require('crypto');
}

import('./main');
