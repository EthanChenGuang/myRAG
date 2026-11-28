# Snowball Italian test vectors

Official vocabulary and expected stems of the Snowball Italian stemmer, used only by
`tests/rag/lexical-stem-it.test.ts` to check the in-repo port `src/lib/rag/lexical/stem-it.ts`.
They are test fixtures and are never loaded at runtime.

| File | Source | Commit | SHA-256 |
| --- | --- | --- | --- |
| `voc.txt` | https://github.com/snowballstem/snowball-data (`italian/voc.txt`) | `019921c3a41c2b70063ee3feb215a00c8e594597` | `8081c7fd8cc1bb0608b504c3a9fb2e7697c4e00457be2db693bd5ca3fad641da` |
| `output.txt` | https://github.com/snowballstem/snowball-data (`italian/output.txt`) | `019921c3a41c2b70063ee3feb215a00c8e594597` | `88ed5959a10f38231f5872d0a9712283f3dbf6ca123282976dacdaf6ed8426b6` |
| `COPYING` | https://github.com/snowballstem/snowball (`COPYING`) | `a113a1a474cb5e5672b6c5e5ef4ded70b3ab39b8` | `880802872ce34f313df826e96131b1b147dcfa09c76fc82129f25503a922a678` |

The algorithm was ported from `algorithms/italian.sbl` of https://github.com/snowballstem/snowball
at commit `a113a1a474cb5e5672b6c5e5ef4ded70b3ab39b8` and the description at
https://snowballstem.org/algorithms/italian/stemmer.html. Snowball and its data are distributed
under the 3-clause BSD licence in `COPYING`; the notice is kept here next to the vectors.
Fetched 2026-11-26.
