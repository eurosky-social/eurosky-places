# Link reviews

Links between places and accounts (a place's website domain is the account's handle) that a
person checked and rejected, so that no later run links them again. One file per checked
area; `rejected[]` names the place (`source`, `id`: the source's own ID, OpenStreetMap as
`n`/`w`/`r` + number), the account (`handle`, `did`) and why the link was wrong.

The patterns behind most rejections: a platform's domain given as a place's website (an
image host, a tip jar, a hosting company), a parent company's account on a subsidiary's
office, a local blog's domain on the cafés and squares it wrote about, and a different
organisation of the same name.
