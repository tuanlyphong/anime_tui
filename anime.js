#!/usr/bin/env node

import { search } from "./lib/search.js";
import { episodes } from "./lib/episodes.js";
import { tsv } from "./lib/output.js";
import { streams } from "./lib/streams.js";

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case "search":
    tsv(await search(args.join(" ")));
    break;
  case "episodes":
    tsv(await episodes(args[0]));
    break;
  case "streams":
    console.log(await streams(args[0]));
    break;
  default:
    console.error("unknown command");
    process.exit(1);
}
