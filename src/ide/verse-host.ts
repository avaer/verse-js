// verse-host.ts
// The IDE's shared Verse host: core stdlib + UEFN extras. Every IDE
// surface (run pipeline, docs panel, Monaco intellisense) consumes this
// one host so they all see the same modules.

import { createHost } from '@/src/verse';
import { uefnModules } from '@/src/verse/extras/uefn';

export const ideHost = createHost({ modules: uefnModules });
