# Plan 05-05, Task 1 (checkpoint:human-verify): package verification evidence

Checked 2026-11-25 (about 07:40 UTC). Nothing was installed and no repository file was changed (`git status` is clean, HEAD `d8046188`).

## Verdicts

| # | Item | Verdict |
|---|------|---------|
| 1 | `@ai-sdk/anthropic` 3.0.143 | **OK**, with one decision for you (lockfile side effect, see 1.6) |
| 2 | `transformers` 5.23.0 | **OK** |
| 3 | `torch` 2.15.0+cpu, and what `uv.lock` resolves today | **OK** (lock already resolves torch 2.15.0+cpu and transformers 5.23.0) |
| 4 | `vectara/hallucination_evaluation_model` @ `de9a5e6b…` | **OK** (size and sha256 match; I recomputed the hash from the full download) |
| 5 | `google/flan-t5-base` @ `7bcac572…` | **OK** (five files present, data only) |
| 6 | `sentencepiece` 0.2.3 | **OK** as a package; probably not needed |
| 7 | Typosquatting | **OK** for all names |

No MISMATCH. Nothing UNVERIFIABLE among the listed checks. Three limits on how the checks were done are listed under "Limits" at the end.

**The one decision:** installing the provider also moves the shared `eventsource-parser` from 3.0.6 to 3.1.1 in `package-lock.json`. Plan 05-05 Task 2 tells the executor to stop if npm proposes any other change, so say now whether that bump is accepted.

---

## 1. `@ai-sdk/anthropic` 3.0.143 — OK

Source: `https://registry.npmjs.org/@ai-sdk%2Fanthropic` (the registry behind npmjs.com). The npmjs.com HTML page answered 403 to automated clients, so open https://www.npmjs.com/package/@ai-sdk/anthropic/v/3.0.143 yourself if you want the rendered view.

| Check | Result |
|---|---|
| 1.1 Repository | `https://github.com/vercel/ai`, directory `packages/anthropic` (registry and the `package.json` inside the tarball agree). License Apache-2.0 |
| 1.2 `ai-v6` dist-tag | `"ai-v6": "3.0.143"`. Other tags: `latest` 4.0.108, `ai-v5` 2.0.115 |
| 1.3 Install scripts | None. `scripts` holds only build, clean, test and type-check entries; no `preinstall`, `install` or `postinstall`; no `hasInstallScript`; no `binding.gyp`, `.node` or shell file among the 58 tarball files |
| 1.4 Dependencies | `@ai-sdk/provider` 3.0.19, `@ai-sdk/provider-utils` 4.0.67; peer `zod ^3.25.76 \|\| ^4.1.8` (the repo has zod 3.25.76) |
| 1.5 Publish date | 2026-11-17T18:39:26Z, 7 days old |

More evidence:

- **Provenance.** Published by GitHub Actions through npm trusted publishing. The SLSA attestation names workflow `.github/workflows/release.yml` in `https://github.com/vercel/ai`, ref `refs/heads/release-v6.0`, commit `8441d47ecb4b8c1b662ed2cfd193787633e14995`. At that commit `packages/anthropic/package.json` reads version 3.0.143 (raw.githubusercontent.com).
- **Integrity.** I downloaded the tarball and hashed it: `sha512-36o4TR2m8JwZ6c+2MkMYPFoTy22BY6q9ZwycR62jU/CDUWoKl1PCgtofFmyR7uZOkpDJcajnce0jl2kDYqUHwg==`, sha1 `1630ff4894628a7c18eb25dabc92941e89ab881d`. Both equal the registry values and the attestation subject digest.
- **Static look at the tarball.** `dist/*.js` requires only `@ai-sdk/provider`, `@ai-sdk/provider-utils` and `zod/v4`. No `child_process`, `eval`, `new Function`, `fs`, `net` or `process.env` use. The only API host is `https://api.anthropic.com`.
- **Popularity and age.** 24,799,734 downloads in the week 2026-11-17 to 11-23; package created 2024-04-12; 695 versions.

### 1.6 Compared with what the repo uses today

| Package | Root `package-lock.json` today | Wanted by 3.0.143 |
|---|---|---|
| `@ai-sdk/provider` | 3.0.0 (2025-12-22) | 3.0.19 exact (2026-10-15) |
| `@ai-sdk/provider-utils` | 4.0.1 (2025-12-23) | 4.0.67 exact (2026-11-17) |
| `eventsource-parser` | 3.0.6 | `^3.0.8` (through provider-utils 4.0.67) |
| `undici` | 6.21.3 (pinned by `@discordjs/rest`) | `^6.28.0` (through provider-utils 4.0.67) |
| `ai` | 6.0.3 | unchanged |

Both dependency versions are on the same `ai-v6` line (`@ai-sdk/provider` tag `ai-v6` = 3.0.19, `@ai-sdk/provider-utils` tag `ai-v6` = 4.0.67), come from `vercel/ai` with provenance, and have no install scripts.

I simulated the lock change in a scratch copy (`npm install --package-lock-only --ignore-scripts --save-exact @ai-sdk/anthropic@3.0.143`, npm 10.9.9, with the repo's `.npmrc`). Result:

```
ADDED    node_modules/@ai-sdk/anthropic                                        3.0.143
ADDED    node_modules/@ai-sdk/anthropic/node_modules/@ai-sdk/provider          3.0.19
ADDED    node_modules/@ai-sdk/anthropic/node_modules/@ai-sdk/provider-utils    4.0.67
ADDED    node_modules/@ai-sdk/anthropic/node_modules/undici                    6.29.1
CHANGED  node_modules/eventsource-parser                                       3.0.6 -> 3.1.1
```

`ai` stays 6.0.3 and `package.json` gains `"@ai-sdk/anthropic": "3.0.143"`.

- The nested `provider` and `provider-utils` copies are what the research expected.
- **`undici` 6.29.1 (new nested copy)** was not listed in the plan's checkpoint text, though the research audit mentions it. Published 2026-10-15 from `nodejs/undici` by GitHub Actions with provenance; no install scripts.
- **`eventsource-parser` 3.0.6 → 3.1.1 (hoisted, shared)** was not anticipated. The existing chat path uses this copy: `@ai-sdk/provider-utils` 4.0.1 (under `ai` 6.0.3 and `@ai-sdk/openai`), `@modelcontextprotocol/sdk` and `eventsource`. Version 3.1.1 was published 2026-08-10 from `rexxars/eventsource-parser` by GitHub Actions with provenance; no install scripts, no dependencies. It is a minor bump of the SSE parser on the streaming path, so it deserves a streaming smoke test after Task 2.

Other notes:

- `@anthropic-ai/sdk` 0.32.1 is already in the lock as a transitive of `@llamaindex/anthropic`. The Task 2 guard only checks `package.json`, so it still passes.
- The `ai-v6` tag is mutable and the line ships roughly weekly (3.0.140 on 11-07, 3.0.142 on 11-10, 3.0.143 on 11-17). Approve the version, not the tag.
- The plan text says latest is 4.0.107; it is now 4.0.108 (2026-11-24). This does not affect the pin.

## 2. `transformers` 5.23.0 — OK

Sources: https://pypi.org/pypi/transformers/5.23.0/json and https://pypi.org/project/transformers/5.23.0/

- Source repository: `https://github.com/huggingface/transformers` (Homepage, shown as "verified by PyPI on Nov 13, 2026").
- License: `Apache 2.0 License`.
- Published 2026-11-13T14:10:36Z (wheel) and 14:10:39Z (sdist); 12 days old. Not yanked. No vulnerabilities listed.
- Provenance: both files carry a PyPI attestation from publisher GitHub `huggingface/transformers`, workflow `release.yml`, environment `pypi-release`.
- Files: `transformers-5.23.0-py3-none-any.whl` sha256 `018e82fd07490ad5bb58414f65e31576033dc7f36bed10c574843f69b90991bf`; `transformers-5.23.0.tar.gz` sha256 `19d647a4d5d903a7c644ca5cde2d86efc3dde7d8c687ae7988806ff2205efa71`. Both are the hashes already in `rag-sidecar/uv.lock`.
- Requires Python `>=3.11.0`; `huggingface-hub<3.0,>=1.31.0`, `tokenizers<0.24.0,>=0.23.1`, `safetensors>=0.8.0` (the lock has 1.33.0, 0.23.3 and 0.8.0).
- The plan text says 5.24.0 is the latest; it is now 5.24.1 (2026-11-24, one day old). The pin on 5.23.0 still makes sense.

## 3. `torch` 2.15.0+cpu — OK

Sources: https://download.pytorch.org/whl/cpu/torch/ and https://pypi.org/pypi/torch/2.15.0/json

CPU index entries for cp312:

| Wheel | sha256 | Uploaded | Size |
|---|---|---|---|
| `torch-2.15.0+cpu-cp312-cp312-manylinux_2_28_x86_64.whl` | `0955c7e3446326293f48af18fad67872fa31dee5a36a87690eb9e5be8b465be3` | 2026-10-28T13:18:39Z | 209,530,490 bytes |
| `torch-2.15.0+cpu-cp312-cp312-manylinux_2_28_aarch64.whl` | `75941d429aaf4450bcd364345d7677e2d54aad45b38fbfcb1c0552450a6e9c40` | 2026-10-28T13:18:32Z | 170,748,402 bytes |

- Both files answer HTTP 200. The index links point at `download-r2.pytorch.org`, which is the host the lock already records.
- Wheel metadata (sha256 `8bbf94c8…`, equal to the index's `data-core-metadata`): `Name: torch`, `Version: 2.15.0+cpu`, `Project-URL: Repository, https://github.com/pytorch/pytorch`. Its seven requirements are filelock, typing-extensions, setuptools, sympy, networkx, jinja2 and fsspec; no CUDA or nvidia packages.
- PyPI `torch` 2.15.0: `Repository` is `https://github.com/pytorch/pytorch`, owner organisation "Meta Platforms", author "PyTorch Team <packages@pytorch.org>", published 2026-10-28 (28 days old), not yanked, no vulnerabilities listed. 2.15.0 is the latest release on both PyPI and the CPU index.
- Cross-check: the macOS arm64 cp312 wheel has the same sha256 on PyPI and on the CPU index (`593e5fd0…a438`).
- PyPI shows no provenance attestation for torch 2.15.0. The PyPI Linux wheels also pull CUDA packages, so the CPU index is the right source.

### What `rag-sidecar/uv.lock` resolves today

- `torch` 2.15.0 (macOS) and 2.15.0+cpu (everything else), source `https://download.pytorch.org/whl/cpu`. All six torch wheel hashes in the lock equal the index today.
- `transformers` 5.23.0 from PyPI, held by `constraint-dependencies` in `pyproject.toml`.
- `sentencepiece` is not in the lock.
- The lock has not moved from the planned versions, so there is no reason to name a different torch version.
- Drift from the plan text: `exclude-newer` is now `2026-11-25T00:00:00Z` in `pyproject.toml` and the lock; the checkpoint says `2026-11-17`. The resolved versions are the same.

## 4. `vectara/hallucination_evaluation_model` @ `de9a5e6ba9ba49531a022dba17e35ffeb2a6fad8` — OK

Sources: `https://huggingface.co/api/models/vectara/hallucination_evaluation_model/revision/de9a5e6b…`, the `/tree/` API and `/raw/` files at that revision.

- License `apache-2.0`. `gated: false`, `private: false`, `disabled: false`. Anonymous download works, including the weights.
- The revision is still the head of `main`, dated 2026-10-06T18:53:37Z, title "Support transformers 5 and refresh model card". Organisation `vectara` is marked verified on the Hub.
- The model card front matter has `extra_gated_fields` (Company, Country). They do nothing while gating is off, but the owner could turn gating on later, and a rebuild that downloads the weights would then need a token.
- Files at the revision: `.gitattributes`, `README.md`, `candle.png`, `config.json`, `configuration_hhem_v2.py`, `model.safetensors`, `modeling_hhem_v2.py`. There are no other Python files.

### `model.safetensors`

| | Expected | Found |
|---|---|---|
| Size | 438,535,352 | 438,535,352 (tree API, `x-linked-size`, and my download) |
| sha256 | `634de18a38cf1e991c1acd0f7a9e0d30f7ea187fba42bb4798f862d3edd31e72` | same (tree API LFS oid, `x-linked-etag`, and the hash I computed over the downloaded bytes) |

### `configuration_hhem_v2.py` (21 lines, sha256 `ec57fe344e3104d0d4a99b13d893529aac1e2bd69e83c2814235baf37cdcacc7`)

- Imports `PretrainedConfig` from transformers.
- Defines `HHEMv2Config` with three class attributes: `model_type = "HHEMv2"`, `foundation = "google/flan-t5-base"`, and the prompt `"<pad> Determine if the hypothesis is true given the premise?\n\nPremise: {text1}\n\nHypothesis: {text2}"`.
- Its constructor is misspelt `__init___` (three underscores), so it never runs; the class attributes are what take effect. A comment in the file says so.
- No network, no file I/O.

### `modeling_hhem_v2.py` (73 lines, sha256 `f1fcfd46e85eef7b941efdcc854ad33e914d328126e28206ca965154e64da262`)

- Imports `torch`, six names from `transformers`, and the config class.
- `HHEMv2Model`: an empty `PreTrainedModel` subclass (its body is commented out).
- `HHEMv2ForSequenceClassification.__init__`: builds `T5ForTokenClassification(AutoConfig.from_pretrained(config.foundation))`, keeps the prompt, loads `AutoTokenizer.from_pretrained(config.foundation)`, calls `post_init()`.
- `populate(model)`: replaces the inner model (a publisher helper, not used at inference).
- `forward(**kwargs)`: eval mode, `torch.no_grad()`, runs the T5 model, keeps the first token's logits.
- `predict(text_pairs)`: fills the prompt with each pair, tokenizes with padding, runs the model, applies softmax, returns the probability of class 1 ("consistent").

Flags:

| Concern | Finding |
|---|---|
| Network access | **Yes, through `from_pretrained` only.** Two calls load `google/flan-t5-base` with no revision, so they contact huggingface.co when the model is built unless the files are cached and offline mode is on. Only the config and tokenizer files are fetched; flan-t5 weights are not |
| File I/O beyond `from_pretrained` | None |
| `subprocess`, `os`, `sys`, `importlib`, `open`, `pickle`, `socket`, `requests`, `ctypes` | None |
| `eval` / `exec` | None. The two `.eval()` hits are `self.t5.eval()`, the torch inference-mode call |
| Obfuscation | None: no non-ASCII characters, no long lines, no encoded strings |

Things to know:

- The plan says "about 80 lines"; the two files are 94 lines including comments and blanks. The content matches the plan's description.
- The answer and evidence text are passed as arguments to `str.format`, not as the format string, so braces in user text are not interpreted.
- `predict` does not truncate. Input length is unbounded, so the caller must cap it (CPU and memory).
- `config.json` at this revision does not set `foundation` or `prompt`, so the defaults above apply.
- The unpinned flan-t5 load is the reason plan 05-17 asserts the flan-t5 commit at build time and runs offline at runtime.

## 5. `google/flan-t5-base` @ `7bcac572ce56db69c1ea7c8af255c5d7c9672fc2` — OK

Sources: `https://huggingface.co/api/models/google/flan-t5-base/revision/7bcac572…`, the `/tree/` API and the files at that revision.

The revision is still the head of `main` (2023-07-17T12:48:39Z, "Update README.md"). License `apache-2.0`, not gated; organisation `google` is marked verified.

| File | Size | sha256 of the download | What it is |
|---|---|---|---|
| `config.json` | 1,404 | `7c1853dbfa0e4aac093eb109a358b6ab25fe86b7c15185a91322f0ed26f0f940` | JSON, `model_type: t5`, no `auto_map` |
| `tokenizer.json` | 2,424,064 | `fe2ebbbbde2985be723e0ce18217853e4020c5e9d35bd07be2c27ab9d3ead57a` | JSON, Unigram model, 32,100 vocabulary entries |
| `tokenizer_config.json` | 2,537 | `4c55124402e4ce48c7125d04b9af152a125eda9e7c80829f8f99f2ec69f3f68d` | JSON, `tokenizer_class: T5Tokenizer` (a built-in class), no `auto_map` |
| `special_tokens_map.json` | 2,201 | `5c87151ef0f72a99d1f766a4c418bd2a1f90aaa30a8e22fe5eca9641daebb64f` | JSON |
| `spiece.model` | 791,656 | `d60acb128cf7b7f2536e8f38a5b18a05535c9e14c7a355904270e15b0945ea86` | SentencePiece protobuf (equals the LFS oid in the tree) |

- All five are data. The git blob ids of the four JSON files equal the tree API; the repository has no `.py` file and no `auto_map`, so nothing here asks for remote code.
- The same revision also holds `pytorch_model.bin` (a pickle), `tf_model.h5`, `flax_model.msgpack` and `model.safetensors`. They are not in the list and must stay out of the download; plan 05-17 already restricts the download to the five files.

## 6. `sentencepiece` 0.2.3 — OK as a package; probably not needed

Sources: https://pypi.org/pypi/sentencepiece/0.2.3/json and https://pypi.org/project/sentencepiece/0.2.3/

- Legitimacy: author "Taku Kudo <taku@google.com>", homepage `https://github.com/google/sentencepiece`, license Apache-2.0, one maintainer account `taku910`. On PyPI since 2017-08-28, 35 releases; 0.2.3 is the latest, published 2026-11-05 (20 days old), not yanked. The GitHub README gives the install command `pip install sentencepiece`.
- Platform wheels: yes. 40 wheels plus an sdist, covering cp310 to cp315 on macOS arm64, manylinux x86_64 and aarch64, and Windows amd64 and arm64. For the sidecar (Python 3.12): `sentencepiece-0.2.3-cp312-cp312-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl` (1,716,727 bytes) and the matching `aarch64` wheel (1,627,109 bytes). No compile step and no dependencies.
- PyPI shows no provenance attestation for this release. It is a compiled C++ extension.
- Need: in the transformers v5.23.0 source, `T5Tokenizer` extends `TokenizersBackend` and imports only `tokenizers`; `sentencepiece` appears in `setup.py` only as an optional extra. `tokenizer.json` exists at the pinned flan-t5 revision. This supports research assumption A4 (the tokenizer loads without sentencepiece), but I read the source and did not run the load.

## 7. Typosquatting — OK

| Name | Why it is the canonical one |
|---|---|
| `@ai-sdk/anthropic` | The AI SDK docs install it by this name (`pnpm add ai @ai-sdk/anthropic`, https://ai-sdk.dev/providers/ai-sdk-providers/anthropic). Scope `@ai-sdk`, provenance from `vercel/ai`, 24.8M weekly downloads. `@anthropic-ai/sdk` is Anthropic's own SDK, a different real package that D-09 keeps out of `package.json` |
| `transformers` | The Hugging Face docs install it by this name (https://huggingface.co/docs/transformers/installation). PyPI provenance from `huggingface/transformers`; on PyPI since 2016, 255 releases |
| `torch` | The same Hugging Face page gives `uv pip install torch --index-url https://download.pytorch.org/whl/cpu`. The index is on pytorch.org's own domain and the wheel metadata names `pytorch/pytorch`. PyPI owner organisation is "Meta Platforms" |
| `sentencepiece` | The `google/sentencepiece` README gives `pip install sentencepiece`; the PyPI homepage points back to that repository |
| `vectara/hallucination_evaluation_model` | Verified `vectara` organisation, created 2023-10-25, 100,348 downloads, 378 likes |
| `google/flan-t5-base` | Verified `google` organisation, created 2022-10-21, 809,959 downloads; it is the `base_model` named by the HHEM card |

## Limits

- The npmjs.com HTML page returned 403 to both fetch tools. All npm facts come from `registry.npmjs.org`, which is the data source of that page.
- I read the npm and PyPI attestations but did not verify their Sigstore signatures cryptographically.
- pytorch.org's "Get Started" page builds its install command in the browser, so I could not read it from there; the canonical name for torch rests on the index, the wheel metadata, PyPI and the Hugging Face docs.

## Recommendation

Approve with `approved, no sentencepiece` (torch stays 2.15.0, the version already locked; no different torch version is needed), and state in the same reply whether the `eventsource-parser` 3.0.6 → 3.1.1 bump and the nested `undici` 6.29.1 that come with the provider are accepted, because Task 2 stops on them otherwise.

## Human approval (2026-11-25)

The user replied "approved, no sentencepiece" to the checkpoint, which was presented with the recommendation to accept both lockfile side effects. Recorded as:
- Approved: @ai-sdk/anthropic 3.0.143 (exact), torch 2.15.0(+cpu) as already locked, transformers 5.23.0 as already locked, HHEM vectara/hallucination_evaluation_model@de9a5e6ba9ba49531a022dba17e35ffeb2a6fad8, google/flan-t5-base@7bcac572ce56db69c1ea7c8af255c5d7c9672fc2 (the five tokenizer and config files only).
- Rejected: sentencepiece 0.2.3.
- Accepted as part of the recommended approval: eventsource-parser 3.0.6 → 3.1.1 (hoisted) and nested undici 6.29.1, which the @ai-sdk/anthropic install brings.
- Task 1 is resolved. Tasks 2 and 3 still wait for the plan precondition (03.1-54 and 04-43 SUMMARYs).
