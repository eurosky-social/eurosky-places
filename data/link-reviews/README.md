# Link reviews

Links between places and accounts (a place's website domain is the account's handle) that a
person checked and rejected, so that no later run links them again. One file per checked
area; `rejected[]` names the place (`source`, `id`: the source's own ID, OpenStreetMap as
`n`/`w`/`r` + number), the account (`handle`, `did`) and why the link was wrong.

The patterns behind most rejections: a platform's domain given as a place's website (an
image host, a tip jar, a hosting company), a parent company's account on a subsidiary's
office, a local blog's domain on the cafés and squares it wrote about, and a different
organisation of the same name.

## Removal requests

The demo map and its README tell people to write to team@eurosky.tech about a wrong link or
to have their place taken off. Each such request becomes an entry in the area's file, with
`reason` saying who asked and when ("owner asked to be removed, 2026-11-02"), so the place
stays off every later build. Self-service removal comes with claiming, where the account's
owner signs in.

