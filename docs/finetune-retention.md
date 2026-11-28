# Fine-tune bundle retention (Phase 6.1, FT-10)

`python -m rag_eval.finetune prune` deletes the text-bearing files of fine-tune bundles (chunks, queries, pairs, training and dev sets, vectors, caches, kits inside the bundle). Manifests and reports stay, since they hold ids, hashes, counts and metrics only.

## What it prunes

- Age: a bundle is pruned once its manifest's `created_at` is more than `--older-than-days` ago (default `retention.retention_days` in `eval/config/finetune.json`, 30). Reading or touching files does not extend it.
- Revocation: `--tenant <key>` prunes every bundle whose manifest lists that tenant, whatever its age. `npm run rag:embedding -- ft-consent revoke --tenant <key> --prune-root <dir>` runs this for you.
- A kit written with `--out` outside the bundle root is not found by the prune; delete it by hand.

## Scheduling it

The bundles are local files on the host that ran `export`, `generate`, `mine` and `train` (default `eval/out/finetune`). Schedule the prune on that same host, with its own scheduler. Do not use Vercel cron: the app deployment has no access to those files, and a serverless function cannot run `uv` against the eval package.

Daily with cron (03:17 host time; adjust the path to the checkout and the bundle root):

```cron
17 3 * * * cd /srv/myrag && uv run --frozen --directory eval python -m rag_eval.finetune prune --root out/finetune >> /var/log/myrag-finetune-prune.log 2>&1
```

Or with a systemd timer:

```ini
# /etc/systemd/system/myrag-finetune-prune.service
[Service]
Type=oneshot
WorkingDirectory=/srv/myrag
ExecStart=/usr/bin/env uv run --frozen --directory eval python -m rag_eval.finetune prune --root out/finetune

# /etc/systemd/system/myrag-finetune-prune.timer
[Timer]
OnCalendar=*-*-* 03:17
Persistent=true

[Install]
WantedBy=timers.target
```

Enable it with `systemctl enable --now myrag-finetune-prune.timer`.

The command prints run ids, file names and counts only (never tenant keys or file contents), so its log is safe to keep. Exit code 0 means done (including "nothing to prune"), 2 a usage error. If bundles are kept on more than one host, schedule the prune on each.
