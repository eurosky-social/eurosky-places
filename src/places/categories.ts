// Every place gets one coarse group, derived from its source category, so ranking can
// prefer places people check into or photograph (a café, a monument) over places they
// rarely do (an ATM, a law firm).
//
// The rules run in two engines: DuckDB during the data load (categoryGroupSql) and
// TypeScript (categoryGroup). Patterns therefore stick to syntax both understand: DuckDB
// uses RE2, which has no lookarounds. First matching rule wins.

export const CATEGORY_GROUPS = [
  "transit",
  "lodging",
  "food_drink",
  "culture",
  "nature",
  "sights",
  "shopping",
  "services",
  "other",
] as const;

export type CategoryGroup = (typeof CATEGORY_GROUPS)[number];

export const CATEGORY_RULES: ReadonlyArray<readonly [CategoryGroup, string]> = [
  // Must come before "nature", whose pattern matches "park".
  ["services", "parking|car_park|car park"],
  ["transit", "(rail|train|subway|metro|tram|bus)[ _]?station|railway=(station|halt)|public_transport=station|aeroway=terminal|airport|aerodrome|ferry|transport hub|light rail"],
  ["lodging", "hotel|hostel|guest_?house|motel|lodging|accommodation|bed and breakfast|bed_and_breakfast|resort|holiday_rental|vacation_rental|campground|camping"],
  ["food_drink", "restaurant|dining|cafe|café|coffee|\\bbars?\\b|_bar\\b|\\bpub\\b|biergarten|beer_garden|brewery|winery|cocktail|fast_food|ice_cream|dessert|tapas|bistro|food_court|nightlife|night_?club|eat_and_drink|food_and_drink|bakery|eatery|snack|burger|pizza|kebab|doner|deli\\b"],
  ["culture", "museum|theat|cinema|movie|gallery|arts_centre|arts and entertainment|arts_and_entertainment|music|concert|opera|\\bzoo\\b|aquarium|stadium|arena|events?_venue|theme_park|amusement|performing|festival|planetarium"],
  ["nature", "\\bpark\\b|_park\\b|garden|nature|natural|beach|lake|forest|mountain|peak|river|waterfall|trail\\b|hiking"],
  ["sights", "landmark|monument|memorial|historic|attraction|viewpoint|scenic|sculpture|statue|castle|palace|church|cathedral|mosque|synagogue|temple|place_of_worship|religious|fountain|bridge|plaza|square|tower|lighthouse|public art|public_art|artwork"],
  ["shopping", "retail|shop|store|shopping|market|boutique|\\bmall\\b"],
  ["services", "office|professional|service|business|government|health|medical|doctor|dentist|clinic|pharmacy|school|education|\\bbank|\\batm\\b|lawyer|attorney|agency|company|insurance|real_estate|repair"],
];

const compiled = CATEGORY_RULES.map(([group, pattern]) => [group, new RegExp(pattern)] as const);

// `description` is whatever the source says about the place's kind, e.g. Overture's
// "coffee_shop food_and_drink > cafe" or Foursquare's "Dining and Drinking > Coffee Shop".
export function categoryGroup(description: string): CategoryGroup {
  const text = description.toLowerCase();
  for (const [group, re] of compiled) {
    if (re.test(text)) return group;
  }
  return "other";
}

// The same rules as a Postgres function `<schema>.category_group(description)`, for
// OpenStreetMap places, which osm2pgsql writes straight into Postgres. Postgres regular
// expressions spell a word boundary `\y` (`\b` means backspace there).
export function categoryGroupPostgresSql(schema: string): string {
  const arms = CATEGORY_RULES.map(
    ([group, pattern]) => `WHEN d ~ '${pattern.replaceAll("\\b", "\\y").replaceAll("'", "''")}' THEN '${group}'`,
  ).join("\n      ");
  return `CREATE OR REPLACE FUNCTION ${schema}.category_group(description text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT CASE
      ${arms}
      ELSE 'other'
    END FROM (SELECT lower(coalesce(description, '')) AS d) AS x
  $$`;
}

// The same rules as a DuckDB macro, `category_group(description)`.
export function categoryGroupMacroSql(): string {
  const arms = CATEGORY_RULES.map(
    ([group, pattern]) =>
      `WHEN regexp_matches(lower(coalesce(description, '')), '${pattern.replaceAll("'", "''")}') THEN '${group}'`,
  ).join("\n    ");
  return `CREATE OR REPLACE MACRO category_group(description) AS (\n  CASE\n    ${arms}\n    ELSE 'other'\n  END\n)`;
}
