// Name comparison for spotting the same place in different sources ("Café Kreuzberg" in
// Foursquare, "Cafe Kreuzberg" in Overture).

export function normalizeName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Whether nameSimilarity(a, b) >= minSimilarity, without computing the full edit distance:
// it allows at most (1 - minSimilarity) × longer length edits, skips pairs whose lengths
// already differ by more, and stops as soon as every path exceeds the budget. Merging runs
// this for every pair of nearby records, hundreds of thousands of times in a dense street.
export function similarEnough(a: string, b: string, minSimilarity: number): boolean {
  if (a === b) return true;
  const longer = Math.max(a.length, b.length);
  const budget = Math.floor((1 - minSimilarity) * longer + 1e-9);
  if (budget === 0 || Math.abs(a.length - b.length) > budget) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
      if (current[j]! < rowMin) rowMin = current[j]!;
    }
    if (rowMin > budget) return false;
    previous = current;
  }
  return previous[b.length]! <= budget;
}

// Whether the shorter name is the leading words of the longer one: "hugendubel" and
// "hugendubel berlin hermannplatz im karstadt" (one source has the brand, the other the
// brand plus where it is).
export function isLeadingWords(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.startsWith(`${short} `);
}

// 1 for identical strings, 0 for nothing in common: one minus the edit distance divided
// by the longer length.
export function nameSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const longer = Math.max(a.length, b.length);
  if (longer === 0) return 1;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
    }
    previous = current;
  }
  return 1 - previous[b.length]! / longer;
}
