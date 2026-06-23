#!/usr/bin/env node

import { search } from "./lib/search.js";
import { episodes } from "./lib/episodes.js";
import { tsv } from "./lib/output.js";
import { streams } from "./lib/streams.js";
import { addHistory, printHistory } from "./lib/history.js";
const cmd = process.argv[2];
const args = process.argv.slice(3);
switch (cmd) {
  case "history":
    printHistory();
    break;

  case "history-add":
    addHistory({
      title: args[0],
      url: args[1],
      poster: args[2],
      latestEpisode: args[3],
    });
    break;

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
