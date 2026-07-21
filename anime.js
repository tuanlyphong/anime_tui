#!/usr/bin/env node

const cmd = process.argv[2];
const args = process.argv.slice(3);
switch (cmd) {
  case "history":
    {
      const { printHistory } = await import("./lib/history.js");
      // optional arg: 'completed' to list completed entries
      printHistory(args[0] === "completed");
    }
    break;

  case "history-add":
    {
      const { addHistory } = await import("./lib/history.js");
      addHistory({
        title: args[0],
        url: args[1],
        poster: args[2],
        latestEpisode: args[3],
      });
    }
    break;

  case "history-complete":
    {
      const { setCompleted } = await import("./lib/history.js");
      // usage: history-complete <url>
      if (!args[0]) {
        console.error("usage: history-complete <url>");
        process.exit(1);
      }
      if (!setCompleted(args[0], true)) {
        console.error("not found");
        process.exit(1);
      }
    }
    break;

  case "history-uncomplete":
    {
      const { setCompleted } = await import("./lib/history.js");
      // usage: history-uncomplete <url>
      if (!args[0]) {
        console.error("usage: history-uncomplete <url>");
        process.exit(1);
      }
      if (!setCompleted(args[0], false)) {
        console.error("not found");
        process.exit(1);
      }
    }
    break;

  case "search":
    {
      const query = args.join(" ").trim();
      if (!query) break;
      const [{ search }, { tsv }] = await Promise.all([
        import("./lib/search.js"),
        import("./lib/output.js"),
      ]);
      tsv(await search(query));
    }
    break;

  case "episodes":
    {
      const [{ episodes }, { tsv }] = await Promise.all([
        import("./lib/episodes.js"),
        import("./lib/output.js"),
      ]);
      tsv(await episodes(args[0]));
    }
    break;

  case "streams":
    {
      const { streams } = await import("./lib/streams.js");
      console.log(await streams(args[0]));
    }
    break;

  default:
    console.error("unknown command");
    process.exit(1);
}
