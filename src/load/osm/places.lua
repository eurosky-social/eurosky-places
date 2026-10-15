-- osm2pgsql flex style: which OpenStreetMap objects become places and streets.
--
-- Writes two staging tables into schema ref_next; src/load/sql/build.sql turns them into
-- the served tables. Only named objects of kinds people check into or photograph are
-- kept. Each place is one point: the node itself, or the centroid of a way or
-- multipolygon (good enough to sort by distance; outlines are not served).

local places = osm2pgsql.define_table({
    name = 'stage_osm_places',
    schema = 'ref_next',
    ids = { type = 'any', type_column = 'osm_type', id_column = 'osm_id' },
    columns = {
        { column = 'name', type = 'text', not_null = true },
        -- The tag that made it a place, e.g. "amenity=restaurant".
        { column = 'category', type = 'text', not_null = true },
        { column = 'wikidata', type = 'text' },
        -- Other names: name:<lang>, alt_name, official_name, short_name, int_name.
        { column = 'names', type = 'jsonb' },
        { column = 'geom', type = 'point', projection = 4326, not_null = true },
    },
})

local streets = osm2pgsql.define_table({
    name = 'stage_osm_streets',
    schema = 'ref_next',
    ids = { type = 'way', id_column = 'osm_id' },
    columns = {
        { column = 'name', type = 'text', not_null = true },
        { column = 'geom', type = 'linestring', projection = 4326, not_null = true },
    },
})

local function set(list)
    local s = {}
    for _, v in ipairs(list) do s[v] = true end
    return s
end

-- Keys that can make a place, in order of precedence: a café in a historic building is
-- a café first. For a key, either only the `allow` values count, or every value except
-- the `deny` ones.
local KEYS = {
    { key = 'amenity', deny = set({
        'parking', 'parking_space', 'parking_entrance', 'bicycle_parking', 'motorcycle_parking',
        'waste_basket', 'waste_disposal', 'recycling', 'bench', 'vending_machine', 'post_box',
        'telephone', 'charging_station', 'atm', 'toilets', 'drinking_water', 'shelter', 'clock',
        'car_sharing', 'taxi', 'loading_dock', 'grit_bin', 'hunting_stand', 'letter_box',
        'parcel_locker', 'bicycle_rental', 'compressed_air', 'water_point', 'bbq', 'give_box',
    }) },
    { key = 'tourism', deny = set({ 'information', 'picnic_site', 'camp_pitch' }) },
    { key = 'shop' },
    { key = 'leisure', deny = set({
        'pitch', 'track', 'picnic_table', 'playground', 'slipway', 'firepit', 'outdoor_seating',
        'common', 'bleachers', 'fitness_station', 'schoolyard', 'dog_park', 'bandstand',
    }) },
    { key = 'historic', deny = set({ 'boundary_stone', 'milestone', 'district_milestone', 'yes' }) },
    { key = 'railway', allow = set({ 'station', 'halt' }) },
    { key = 'public_transport', allow = set({ 'station' }) },
    { key = 'aeroway', allow = set({ 'aerodrome', 'terminal' }) },
    { key = 'natural', allow = set({
        'peak', 'volcano', 'beach', 'cave_entrance', 'glacier', 'cliff', 'arch', 'saddle',
        'hot_spring', 'geyser', 'water', 'bay', 'cape', 'spring', 'rock', 'stone', 'tree', 'wood',
    }) },
    { key = 'waterway', allow = set({ 'waterfall' }) },
    { key = 'man_made', allow = set({
        'tower', 'lighthouse', 'windmill', 'watermill', 'obelisk', 'observatory', 'bridge',
        'pier', 'water_tower',
    }) },
    { key = 'place', allow = set({ 'square', 'island', 'islet' }) },
    { key = 'office' },
    { key = 'craft' },
    { key = 'healthcare' },
}

local function category(tags)
    for _, k in ipairs(KEYS) do
        local value = tags[k.key]
        if value and value ~= 'no' then
            if (k.allow and k.allow[value]) or (not k.allow and not (k.deny and k.deny[value])) then
                return k.key .. '=' .. value
            end
        end
    end
    return nil
end

local OTHER_NAMES = set({ 'alt_name', 'official_name', 'short_name', 'int_name' })

local function other_names(tags)
    local names = {}
    local found = false
    for k, v in pairs(tags) do
        local lang = k:match('^name:([%a_%-]+)$')
        if lang then
            names[lang] = v
            found = true
        elseif OTHER_NAMES[k] then
            names[k] = v
            found = true
        end
    end
    if found then return names end
    return nil
end

local function wikidata(tags)
    local q = tags.wikidata
    if q and q:match('^Q%d+$') then return q end
    return nil
end

-- Never places, whatever else they are tagged with. Stolpersteine, the brass stones for
-- individual victims of Nazism, are mapped as historic=memorial and named after the
-- person (~9,000 in Berlin alone): not somewhere to check in, and they would bury every
-- other sight.
local function excluded(tags)
    return tags.memorial == 'stolperstein' or tags['memorial:type'] == 'stolperstein'
end

local function add_place(object, geom)
    local tags = object.tags
    if not tags.name or geom == nil or excluded(tags) then return end
    local kind = category(tags)
    if not kind then return end
    places:insert({
        name = tags.name,
        category = kind,
        wikidata = wikidata(tags),
        names = other_names(tags),
        geom = geom,
    })
end

local STREET_TYPES = set({
    'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential',
    'living_street', 'pedestrian', 'service', 'road',
})

function osm2pgsql.process_node(object)
    add_place(object, object:as_point())
end

function osm2pgsql.process_way(object)
    local tags = object.tags
    if tags.name and STREET_TYPES[tags.highway] then
        streets:insert({ name = tags.name, geom = object:as_linestring() })
    end
    if object.is_closed then
        add_place(object, object:as_polygon():centroid())
    else
        add_place(object, object:as_linestring():centroid())
    end
end

function osm2pgsql.process_relation(object)
    if object.tags.type == 'multipolygon' then
        add_place(object, object:as_multipolygon():centroid())
    end
end
