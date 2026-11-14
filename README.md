# tornpda-scripts-and-browser
The text based browser game torn(.com) gameplay script to help enhance gameplay experience, elements, play through with less effort. 

## Scripts

| Script | Version | What it does |
|---|---|---|
| [torn-target-info](torn-target-info/torn-target-info.user.js) | 1.8 | Target info, attack/mug history with MUG/SKIP verdicts, FFScouter estimates, target finder. Profile and attack pages. |
| [torn-gear-finder](torn-gear-finder/torn-gear-finder.user.js) | 1.0 | Finds better weapons/armor and missing enhancers across inventory and faction armory. |

Both work in Torn PDA and Tampermonkey. In PDA the key placeholder `###PDA-APIKEY###` is filled in automatically.

## Changelog: torn-target-info

- 1.8: runs on attack pages as well as profiles (`loader.php` match, panel re-attaches if Torn removes it)
- 1.7: per-stat (4-way) battle stat guess, widening split as totals grow
- 1.6: level-based fallback stat estimate (200K-2.5M) when FFScouter has no data; finder uses it instead of a level cap
- 1.5: original version (saved in `torn-target-info/versions/v1.5.user.js`)

Versions 1.6 and 1.7 were edited in place, so only 1.5 and the current 1.8 exist as files.
