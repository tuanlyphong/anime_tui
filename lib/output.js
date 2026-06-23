export function tsv(rows) {
  for (const row of rows) {
    // Episodes carry `name` ("Tập 01"); search results carry `title`.
    // Fall back title → "" so neither prints "undefined".
    const label = row.name ?? row.title ?? "";
    console.log([label, row.url, row.poster ?? ""].join("\t"));
  }
}
