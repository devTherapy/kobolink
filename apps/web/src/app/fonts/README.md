# Self-hosted fonts

IBM Plex Sans and IBM Plex Mono, loaded by `../fonts.ts` through `next/font/local`.
Committed so that `next build` (CI, the e2e harness, the Docker/Fly image build)
never has to reach fonts.googleapis.com or fonts.gstatic.com. D31.

`../fonts.guard.test.ts` fails if `next/font/google` comes back, or if a file
referenced from `fonts.ts` is missing, empty or not a woff2.

## Provenance

The files are byte-for-byte the woff2 files published in these npm packages
(public registry, no credentials). The packages are **not** dependencies of this
repo; they were downloaded once with `npm pack` and only the files below copied.

| Package | Version | Used for |
|---|---|---|
| `@fontsource-variable/ibm-plex-sans` | 5.3.0 | Sans, `*-wght-normal.woff2` (variable, weight axis only) |
| `@fontsource/ibm-plex-mono` | 5.3.0 | Mono, `*-400-normal.woff2` and `*-500-normal.woff2` (static) |

Upstream: https://github.com/IBM/plex (IBM Plex Sans is distributed as a
variable font; Plex Mono has no variable build). Slices are `latin`,
`latin-ext` and `vietnamese`, the unicode ranges Google served (cyrillic and
greek dropped). `latin-ext` carries the naira sign U+20A6; `vietnamese` carries
the dotted vowels used in Yoruba and Igbo names.

To update: `npm pack <package>@<version>`, extract, copy the same file names
from `package/files/`, update the table below, and run `npm run test:web`.

## Files (sha256)

| File | Bytes | sha256 |
|---|---|---|
| `ibm-plex-sans-latin-wght-normal.woff2` | 45712 | `e2291e842cf5af167122a22881a740c7f2dda7716f1e8cd76680264f4a859470` |
| `ibm-plex-sans-latin-ext-wght-normal.woff2` | 30964 | `d160e20920ae4d6556518d352d3af27a74e9b0de3d8fe17b1c1044fc75aa2f81` |
| `ibm-plex-sans-vietnamese-wght-normal.woff2` | 13160 | `73e7f7b1c980416ae0c2461268b14c7cfcce0668e683dc43fbb11a82a227b9f2` |
| `ibm-plex-mono-latin-400-normal.woff2` | 14708 | `08949f728dc52d528e69b1667d15c89a5686a4ee9a296ff90983985f99c380f7` |
| `ibm-plex-mono-latin-500-normal.woff2` | 14888 | `01d285447409c8a588692162439a038b8cbd7871309ee20267b0d2d91c6e8e22` |
| `ibm-plex-mono-latin-ext-400-normal.woff2` | 13348 | `6bc0f226a5b7884a8170e3f62c63d7675609d4631bdc5931b5cdab81821f00eb` |
| `ibm-plex-mono-latin-ext-500-normal.woff2` | 13432 | `6bb06407c97584b0867a959e05e8874693bfeb8c317de190811c51598f2d99ea` |
| `ibm-plex-mono-vietnamese-400-normal.woff2` | 5868 | `62632b6375305e70ddcafdd895218e6ae41a184fcd280a69c739460604ca00a9` |
| `ibm-plex-mono-vietnamese-500-normal.woff2` | 6040 | `781633d95de88040fb77141d1e65d928c87c0144691fbc74da5a64d137a7e910` |

Total 158,120 bytes (about 154 KiB).

## Licence

SIL Open Font License, Version 1.1. Redistribution, including bundling in a
web application, is permitted; the Font Software may not be sold on its own and
the licence text must travel with it. The full text is in `OFL-ibm-plex-sans.txt`
and `OFL-ibm-plex-mono.txt` (copied unmodified from the packages' `LICENSE`).

- IBM Plex Sans: Copyright 2019 IBM Corp. All rights reserved.
- IBM Plex Mono: Copyright 2017 IBM Corp. All rights reserved.
