# tornpda-scripts-and-browser
The text based browser game torn(.com) gameplay script to help enhance gameplay experience, elements, play through with less effort. 

## Scripts

| Script | Version | What it does |
|---|---|---|
| [torn-target-info](torn-target-info/torn-target-info.user.js) | 1.9 | Target info, attack/mug history with MUG/SKIP verdicts, FFScouter estimates, target finder ranked by mug likelihood. Profile and attack pages. |
| [torn-gear-finder](torn-gear-finder/torn-gear-finder.user.js) | 1.0 | Finds better weapons/armor and missing enhancers across inventory and faction armory. |
| [torn-rental-finder](torn-rental-finder/torn-rental-finder.user.js) | 1.0 | Ranks property rentals by true daily cost (rent + upkeep) and cost per happy. |
| [torn-recent-attack-check](torn-recent-attack-check/torn-recent-attack-check.user.js) | 2.1.0 | Shows whether a player was attacked in the last 16h (by you or others, via defend-stat deltas). Profile and attack pages. |

All work in Torn PDA and Tampermonkey. In PDA the key placeholder `###PDA-APIKEY###` is filled in automatically.

## Changelog: torn-target-info

- 1.9: FFScouter linked to mug outlook. Each target gets a Mug rank (outlook x stats factor); the finder shows one list, best mug targets first, and drops targets too strong for you. Old v1.8 saved in `versions/`
- 1.8: runs on attack pages as well as profiles (`loader.php` match, panel re-attaches if Torn removes it)
- 1.7: per-stat (4-way) battle stat guess, widening split as totals grow
- 1.6: level-based fallback stat estimate (200K-2.5M) when FFScouter has no data; finder uses it instead of a level cap
- 1.5: original version (saved in `torn-target-info/versions/v1.5.user.js`)

Versions 1.6 and 1.7 were edited in place, so only 1.5, 1.8 and the current version exist as files.

## Notes: torn-recent-attack-check

- Your own attacks on the target are exact (attack log). Attacks by others are inferred from the target's defends won/lost/stalemated counters, so only counts are shown, not who or when.
- Accuracy of the 16h window depends on the baseline: your own earlier snapshot (exact), else Torn's daily historical stats (~approx).
