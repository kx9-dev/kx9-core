import {build} from "esbuild";import fs from "node:fs";
fs.rmSync("dist",{recursive:true,force:true});
await build({entryPoints:["src/index.ts"],bundle:true,platform:"node",format:"esm",packages:"external",outfile:"dist/index.mjs",sourcemap:true,banner:{js:'import {createRequire} from "node:module"; const require=createRequire(import.meta.url);'}});
