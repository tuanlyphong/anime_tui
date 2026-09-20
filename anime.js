#!/usr/bin/env node

async function main() {
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

    case "episodes-progress":
      {
        const [{ episodes }, { decorateEpisodes }] = await Promise.all([
          import("./lib/episodes.js"), import("./lib/progress.js"),
        ]);
        const rows = await decorateEpisodes(args[0], await episodes(args[0]));
        const pathname = value => new URL(value, "https://anime.invalid").pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
        const override = args[1] && rows.find(row => pathname(row.url) === pathname(args[1]));
        const field = value => String(value ?? "").replace(/[\t\r\n]/g, " ");
        for (const row of rows) {
          const original = row.name || row.title;
          const display = original + row.display.slice(String(row.title ?? row.name ?? "").length);
          console.log([display, row.url, original, (override ? row === override : row.preferred) ? 1 : 0].map(field).join("\t"));
        }
      }
      break;

    case "play-episode":
      {
        try {
          const [streamUrl, animeUrl, episodeUrl, label, ...flags] = args;
          if (!streamUrl || !animeUrl || !episodeUrl || !label) {
            throw new Error("usage: play-episode <stream> <anime-url> <episode-url> <label> [--player executable] [--player-arg argument] [--progressive-player-arg argument] [--jar path] [--quality h|m|l] [--progressive 0|1]");
          }
          const options = { streamUrl, animeUrl, episodeUrl, label, playerArgs: [], progressivePlayerArgs: [] };
          for (let i = 0; i < flags.length; i += 2) {
            const flag = flags[i], value = flags[i + 1];
            if (value === undefined) throw new Error(`Missing value for option ${flag}`);
            switch (flag) {
              case "--player": options.player = value; break;
              case "--player-arg": options.playerArgs.push(value); break;
              case "--progressive-player-arg": options.progressivePlayerArgs.push(value); break;
              case "--jar": options.jar = value; break;
              case "--quality": options.quality = value; break;
              case "--progressive":
                if (!["0", "1"].includes(value)) throw new Error("--progressive must be 0 or 1");
                options.progressive = value !== "0"; break;
              default: throw new Error(`Unknown option ${flag}`);
            }
          }
          const { playEpisode } = await import("./lib/playback.js");
          const { outcome, error } = await playEpisode(options);
          if (error) console.error(error.message);
          console.log(outcome);
          if (outcome === "failed") process.exitCode = 1;
        } catch (error) {
          console.error(error.message);
          console.log("failed");
          process.exitCode = 1;
        }
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

    case "abyss-stream":
      {
        const [jar, id, quality = "h"] = args;
        if (!jar || !id) {
          console.error("usage: abyss-stream <jar> <id> [h|m|l]");
          process.exit(1);
        }
        const { streamAbyss } = await import("./lib/abyss-progressive.js");
        await streamAbyss({ jar, id, quality });
      }
      break;

    default:
      console.error("unknown command");
      process.exit(1);
  }
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
