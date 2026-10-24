import assert from "node:assert/strict";
import { test } from "node:test";
import { charMask, isLeadingWords, nameSimilarity, normalizeName, similarEnough } from "../src/places/names.ts";
import { mergeCandidates, rankSuggestions, samePlace, type Candidate } from "../src/places/rank.ts";
import { collapseAreas, type Area } from "../src/suggest.ts";

const base = { lat: 52.4867, lng: 13.4245, category: null };
const fsq = (id: string, name: string, group: Candidate["group"], distance: number, north = 0): Candidate => ({
  ...base,
  origin: `urn:atgeo:foursquare.com:place:${id}`,
  dataset: "foursquare.com",
  name,
  group,
  distance,
  lat: base.lat + north / 111_320,
});
const ov = (id: string, name: string, group: Candidate["group"], distance: number, north = 0): Candidate => ({
  ...fsq(id, name, group, distance, north),
  origin: `urn:atgeo:overturemaps.org:place:${id}`,
  dataset: "overturemaps.org",
});

test("normalizeName ignores accents, case and punctuation", () => {
  assert.equal(normalizeName("Café  Kreuzberg!"), "cafe kreuzberg");
  assert.equal(normalizeName("McDonald's"), "mcdonald s");
  assert.equal(normalizeName("Ostertor-Viertel"), "ostertor viertel");
});

test("nameSimilarity is one minus the edit distance over the longer name", () => {
  assert.equal(nameSimilarity("abc", "abc"), 1);
  assert.equal(nameSimilarity("u hermannplatz", "hermannplatz"), 1 - 2 / 14);
  assert.equal(nameSimilarity("", ""), 1);
});

test("similarEnough agrees with nameSimilarity on every pair", () => {
  const names = [
    "mcdonald s", "mcdonalds", "cafe kreuzberg", "cafe kreuzberk", "u hermannplatz", "hermannplatz",
    "hugendubel", "hugendubel berlin", "zapfhahn", "zapfhan", "spati", "spaeti", "", "a",
    "huxleys neue welt", "huxley s neue welt", "the coffee ape berlin", "the coffee ape",
  ];
  for (const a of names) {
    for (const b of names) {
      for (const min of [0.8, 0.9, 0.95]) {
        assert.equal(similarEnough(a, b, min), nameSimilarity(a, b) >= min, `${a} / ${b} @ ${min}`);
        // The character masks only skip pairs that cannot be similar enough.
        assert.equal(similarEnough(a, b, min, charMask(a), charMask(b)), nameSimilarity(a, b) >= min, `masks: ${a} / ${b} @ ${min}`);
      }
    }
  }
});

test("a name that is the leading words of another merges only when close and of the same kind", () => {
  const brand = fsq("h", "Hugendubel", "shopping", 0);
  const branch = (metres: number) => ov("h", "Hugendubel Berlin Hermannplatz im Karstadt", "shopping", metres, metres);
  assert.equal(mergeCandidates([brand, branch(12)]).length, 1);
  assert.equal(mergeCandidates([brand, branch(60)]).length, 2);
  assert.equal(
    mergeCandidates([fsq("k", "Karstadt", "shopping", 0), ov("r", "Karstadt Reisebüro", "services", 5, 5)]).length,
    2,
  );
  assert.equal(isLeadingWords("hugen", "hugendubel berlin"), false, "whole words only");
  assert.equal(isLeadingWords("abc", "abc def"), false, "too short to be a brand");
});

test("the same place in two sources becomes one suggestion with the Foursquare ID", () => {
  const merged = mergeCandidates([
    ov("mc", "McDonald's", "food_drink", 37, 37),
    fsq("mc", "McDonald's", "food_drink", 8, 8),
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.origin, "urn:atgeo:foursquare.com:place:mc");
  assert.deepEqual(merged[0]!.sameAs, ["urn:atgeo:overturemaps.org:place:mc"]);
  assert.equal(merged[0]!.distance, 8);
});

test("places are not merged across a large distance, different kinds, or within one source", () => {
  assert.equal(mergeCandidates([fsq("a", "Späti", "shopping", 0), ov("b", "Späti", "shopping", 100, 100)]).length, 2);
  assert.equal(mergeCandidates([fsq("a", "Hermannplatz", "transit", 0), ov("b", "Hermannplatz", "sights", 0)]).length, 2);
  assert.equal(mergeCandidates([fsq("a", "Späti", "shopping", 0), fsq("b", "Späti", "shopping", 20, 20)]).length, 2);
});

test("a kind marked 'other' can merge with any kind", () => {
  const merged = mergeCandidates([fsq("a", "Zapfhahn", "food_drink", 0), ov("b", "Zapfhahn", "other", 10, 10)]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.group, "food_drink");
});

test("ranking prefers places people pick over closer services", () => {
  const ranked = rankSuggestions(
    mergeCandidates([
      ov("atm", "ING-Geldautomat", "services", 5),
      fsq("cafe", "The Coffee Ape", "food_drink", 30, 30),
    ]),
  );
  assert.deepEqual(ranked.map((s) => s.name), ["The Coffee Ape", "ING-Geldautomat"]);
});

test("the grid-based merge groups exactly like comparing every pair", () => {
  // The straightforward version: scan all clusters for each candidate.
  const reference = (candidates: Candidate[]) => {
    const clusters: Array<Array<Candidate & { key: string }>> = [];
    const order = (a: Candidate, b: Candidate) => a.distance - b.distance || (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0);
    for (const candidate of [...candidates].sort(order)) {
      const c = { ...candidate, key: normalizeName(candidate.name) };
      const home = clusters.find((ms) => !ms.some((m) => m.dataset === c.dataset) && ms.some((m) => samePlace(m, c)));
      if (home) home.push(c);
      else clusters.push([c]);
    }
    return clusters.map((ms) => ms.map((m) => m.origin).sort().join(" ")).sort();
  };
  let seed = 7;
  const random = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
  const names = ["Späti", "Spati", "McDonald's", "Café Kreuzberg", "Cafe Kreuzberg", "Hugendubel", "Hugendubel Berlin", "Zapfhahn"];
  const groups: Candidate["group"][] = ["food_drink", "shopping", "other"];
  for (let round = 0; round < 20; round++) {
    const candidates: Candidate[] = Array.from({ length: 300 }, (_, i) => {
      const north = (random() - 0.5) * 600;
      const east = (random() - 0.5) * 600;
      return {
        origin: `urn:atgeo:${["foursquare.com", "overturemaps.org", "openstreetmap.org"][i % 3]}:place:${round}-${i}`,
        dataset: ["foursquare.com", "overturemaps.org", "openstreetmap.org"][i % 3]!,
        name: names[Math.floor(random() * names.length)]!,
        category: null,
        group: groups[Math.floor(random() * groups.length)]!,
        lat: 52.4867 + north / 111_320,
        lng: 13.4245 + east / 67_780,
        distance: Math.hypot(north, east),
      };
    });
    const merged = mergeCandidates(candidates).map((s) => [s.origin, ...s.sameAs].sort().join(" ")).sort();
    assert.deepEqual(merged, reference(candidates), `round ${round}`);
  }
});

test("character masks never rule out names within the edit budget", () => {
  // Random edits of random names, Latin and Japanese: one edit changes at most two bits.
  let seed = 11;
  const random = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789 渋谷駅東口カフェスタバ";
  const pick = () => alphabet[Math.floor(random() * alphabet.length)]!;
  for (let i = 0; i < 5000; i++) {
    const a = Array.from({ length: 5 + Math.floor(random() * 30) }, pick).join("");
    let b = a;
    for (let e = Math.floor(random() * 4); e > 0; e--) {
      const at = Math.floor(random() * (b.length + 1));
      const op = Math.floor(random() * 3);
      b = op === 0 ? b.slice(0, at) + pick() + b.slice(at) : op === 1 ? b.slice(0, at) + b.slice(at + 1) : b.slice(0, at) + pick() + b.slice(at + 1);
    }
    for (const min of [0.8, 0.9]) {
      assert.equal(similarEnough(a, b, min, charMask(a), charMask(b)), nameSimilarity(a, b) >= min, `${a} / ${b} @ ${min}`);
    }
  }
});

test("merging does not depend on the order the database returns records in", () => {
  // Several records on exactly the same spot (a building's entrance), as at Times Square.
  const stacked: Candidate[] = [
    fsq("a", "Times Square", "sights", 40),
    fsq("b", "Times Square", "sights", 40),
    ov("c", "Times Square", "sights", 40),
    ov("d", "Times Sq", "sights", 40),
    fsq("e", "Café", "food_drink", 40),
    ov("f", "Cafe", "food_drink", 40),
  ];
  const groups = (cs: Candidate[]) => mergeCandidates(cs).map((s) => [s.origin, ...s.sameAs].join(" "));
  const expected = groups(stacked);
  let seed = 3;
  const random = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
  for (let i = 0; i < 50; i++) {
    const shuffled = [...stacked].sort(() => random() - 0.5);
    assert.deepEqual(groups(shuffled), expected);
  }
});

test("collapseAreas keeps the smallest of a run of same-named areas", () => {
  const area = (name: string, subtype: string): Area => ({ origin: `urn:x:${subtype}`, name, subtype, country: "FR", lat: 0, lng: 0 });
  const collapsed = collapseAreas([
    area("Quartier des Archives", "neighborhood"),
    area("Paris", "locality"),
    area("Paris", "localadmin"),
    area("Paris", "county"),
    area("Île-de-France", "region"),
    area("France", "country"),
  ]);
  assert.deepEqual(collapsed.map((a) => `${a.name}/${a.subtype}`), [
    "Quartier des Archives/neighborhood",
    "Paris/locality",
    "Île-de-France/region",
    "France/country",
  ]);
});

test("an area kept for a run of same-named areas is a city-state if one of them is", () => {
  const area = (name: string, subtype: string, cityState?: true): Area => ({
    origin: `urn:x:${subtype}`, name, subtype, ...(cityState ? { cityState } : {}), country: "CD", lat: 0, lng: 0,
  });
  // Kinshasa: the region is the city (Q3838); the same-named locality and county are not.
  const collapsed = collapseAreas([
    area("Mongala", "locality"),
    area("Kinshasa", "locality"),
    area("Kinshasa", "county"),
    area("Kinshasa", "region", true),
    area("RD Congo", "country"),
  ]);
  assert.deepEqual(collapsed.map((a) => `${a.name}/${a.subtype}/${a.cityState ?? "-"}`), [
    "Mongala/locality/-",
    "Kinshasa/locality/true",
    "RD Congo/country/-",
  ]);
});
