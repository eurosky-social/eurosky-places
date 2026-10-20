import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { jsonToLex } from "@atproto/lexicon";
import { lexicons } from "./helpers/lexicons.ts";

// docs/place-pin.md is a proposal other projects read: its examples must stay valid records
// of the lexicon it proposes.
test("the place-pin proposal's examples are valid social.eurosky.place.pin records", async () => {
  const lex = await lexicons();
  const doc = await readFile(new URL("../docs/place-pin.md", import.meta.url), "utf8");
  const examples = [...doc.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]!));
  assert.ok(examples.length >= 3, "found the examples");
  for (const example of examples) {
    assert.equal(example.$type, "social.eurosky.place.pin");
    lex.assertValidRecord("social.eurosky.place.pin", jsonToLex(example));
  }
  // And the schema still refuses what it should.
  const [first] = examples;
  assert.throws(() => lex.assertValidRecord("social.eurosky.place.pin", jsonToLex({ ...first, place: undefined })));
  assert.throws(() =>
    lex.assertValidRecord("social.eurosky.place.pin", jsonToLex({ ...first, media: [{ cid: { $link: "not-a-cid" } }] })),
  );
});
