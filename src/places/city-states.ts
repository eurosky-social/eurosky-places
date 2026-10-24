// Cities that Overture files as regions ("city-states"), by Wikidata ID. Overture puts them
// at the level of states and provinces and often files their boroughs as localities (Berlin
// is a region, Friedrichshain-Kreuzberg a locality), so an app that reads the subtypes as
// levels calls the borough the city and the city a region. Answers mark areas with one of
// these IDs `cityState` (suggestions, search, squares, org.atgeo.getPlace). That happens at
// query time, by each division's Wikidata ID, so the list applies to the loaded data as is.
//
// What belongs here: a region whose Wikidata item is the city itself (Berlin's region is
// Q64, the city of Berlin), checked against Wikidata and against the served data, where the
// city has to be a `region`. Not a state, province or district that contains several
// cities or is a separate item from its city, even when it carries the city's name: Bremen
// (Q1209: Bremen and Bremerhaven), the Brussels-Capital Region (Q240; the City of Brussels
// is Q239), the Bratislava Region, Tokyo (a prefecture with 26 cities besides the wards),
// Chongqing, the District of Columbia (Q3551781, with the city of Washington, Q61, a
// locality inside it), and the cities in Vietnam and Taiwan that took in whole provinces or
// counties (Ho Chi Minh City, Da Nang, Kaohsiung, New Taipei, …). Checked 2026-10-24
// against Overture 2026-09-23.1.
export const CITY_STATE_IDS: readonly string[] = [
  // Europe
  "Q64", // Berlin
  "Q1055", // Hamburg
  "Q1741", // Vienna
  "Q1085", // Prague
  "Q19660", // Bucharest
  "Q1435", // Zagreb
  "Q1899", // Kyiv
  "Q2280", // Minsk
  "Q649", // Moscow
  "Q656", // Saint Petersburg
  "Q585", // Oslo
  "Q5823", // Ceuta
  "Q5831", // Melilla
  // Latvia's state cities that are municipalities of their own
  "Q1773", // Riga
  "Q80021", // Daugavpils
  "Q179830", // Jelgava
  "Q178382", // Jūrmala
  "Q167668", // Liepāja
  "Q180379", // Rēzekne
  "Q104036", // Ventspils

  // Caucasus and Central Asia
  "Q994", // Tbilisi
  "Q1953", // Yerevan
  "Q1520", // Astana
  "Q35493", // Almaty
  "Q485496", // Shymkent
  "Q9361", // Bishkek
  "Q9365", // Dushanbe
  "Q23438", // Ashgabat
  "Q269", // Tashkent

  // East Asia
  "Q956", // Beijing
  "Q8686", // Shanghai
  "Q11736", // Tianjin
  "Q23430", // Ulaanbaatar
  "Q8684", // Seoul
  "Q16520", // Busan
  "Q20927", // Daegu
  "Q20934", // Incheon
  "Q20921", // Daejeon
  "Q41278", // Ulsan
  "Q20929", // Sejong
  "Q18808", // Pyongyang
  "Q1867", // Taipei
  "Q249996", // Keelung
  "Q249994", // Hsinchu
  "Q249995", // Chiayi

  // South and Southeast Asia, Middle East
  "Q1861", // Bangkok
  "Q1850", // Phnom Penh
  "Q1858", // Hanoi
  "Q36399", // Huế
  "Q1865", // Kuala Lumpur
  "Q182378", // Putrajaya
  "Q3630", // Jakarta
  "Q9347", // Malé
  "Q3861", // Doha

  // Africa
  "Q3624", // Addis Ababa
  "Q193486", // Dire Dawa
  "Q3838", // Kinshasa
  "Q3733", // Conakry
  "Q3889", // Maputo
  "Q3859", // Kigali
  "Q3674", // Niamey
  "Q3832", // Bangui
  "Q3659", // N'Djamena
  "Q3604", // Djibouti

  // Americas
  "Q1489", // Mexico City
  "Q2841", // Bogotá
  "Q1486", // Buenos Aires
  "Q2933", // Asunción
  "Q39178", // Port of Spain
];

const CITY_STATES = new Set(CITY_STATE_IDS);

export function isCityState(wikidata: string | null | undefined): boolean {
  return !!wikidata && CITY_STATES.has(wikidata);
}

// To spread into an area of an answer: the field is there only when it is true.
export function cityStateField(wikidata: string | null | undefined): { cityState?: true } {
  return isCityState(wikidata) ? { cityState: true } : {};
}
