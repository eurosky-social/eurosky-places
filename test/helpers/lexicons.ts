import { readdir, readFile } from "node:fs/promises";
import { Lexicons } from "@atproto/lexicon";

// Copies of other projects' published lexicons (test/fixtures/lexicons/README.md says where
// each comes from) plus this repo's own, so tests can check answers and examples against the
// schemas other apps read them with.
const DIRS = [new URL("../fixtures/lexicons/", import.meta.url), new URL("../../lexicons/social/eurosky/place/", import.meta.url)];

export async function lexicons(): Promise<Lexicons> {
  const lex = new Lexicons();
  for (const dir of DIRS) {
    for (const file of (await readdir(dir)).filter((f) => f.endsWith(".json")).sort()) {
      lex.add(JSON.parse(await readFile(new URL(file, dir), "utf8")));
    }
  }
  return lex;
}
