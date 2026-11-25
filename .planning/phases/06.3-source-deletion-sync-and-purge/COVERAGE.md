# API Coverage — Microsoft Graph (through the Nango proxy) and Nango

> Full coverage by default. Opt-outs are explicit, reasoned decisions. Phase 6.3 is a read-only connector plus deletion sync, so write capabilities are opted out.

| capability | decision | reason |
|---|---|---|
| graph.drive-root-delta | INTEGRATE | |
| graph.sites-list-and-search | INTEGRATE | |
| graph.site-drives-and-me-drives | INTEGRATE | |
| graph.folder-children | INTEGRATE | |
| graph.item-content-download | INTEGRATE | |
| graph.item-permissions-list | INTEGRATE | |
| graph.retry-after-throttling | INTEGRATE | |
| graph.item-get-single | OPT-OUT | not needed: delta and children responses carry every field the sync uses |
| graph.change-notifications-subscriptions | OPT-OUT | not needed yet: Nango webhooks plus delta reads cover changes; subscriptions need a public endpoint and renewal, follow-up phase |
| graph.json-batch | OPT-OUT | not needed yet: one permission request per item is correct; batching is an efficiency follow-up (RESEARCH A9) |
| graph.item-create-update-delete-upload | OPT-OUT | explicitly out of scope: the connector only reads |
| graph.sharing-links-create | OPT-OUT | explicitly out of scope: the connector only reads |
| graph.delta-show-sharing-changes | OPT-OUT | not needed: requires Sites.FullControl.All and two more Prefer values; eTag changes trigger a permission re-read instead |
| graph.item-versions | OPT-OUT | not needed: the knowledge base versions documents by content hash |
| graph.drive-search | OPT-OUT | not needed: delta enumeration is the complete listing |
| graph.thumbnails | OPT-OUT | not needed: page pictures come from the ingest pipeline |
| graph.sharepoint-lists-and-list-items | OPT-OUT | explicitly out of scope: document libraries (drives) only |
| graph.onedrive-personal | OPT-OUT | explicitly out of scope: different base URL (api.onedrive.com), not in DATA-25 |
| nango.provider-sharepoint-online-oauth2-cc | OPT-OUT | not needed yet: delegated providers chosen (D-40); documented as the option for complete permission lists |
| nango.proxy | INTEGRATE | |
| nango.records-list-deleted-cursor | INTEGRATE | |
| nango.webhook-sync | INTEGRATE | |
| nango.webhook-auth | INTEGRATE | |
| nango.webhook-hmac-sha256-signature | INTEGRATE | |
| nango.connect-session | INTEGRATE | |
| nango.webhook-legacy-signature | OPT-OUT | explicitly out of scope: the legacy scheme is refused for security (D-32) |
| nango.webhook-forward | OPT-OUT | not needed: no provider webhook is forwarded in this phase |
| nango.trigger-sync | OPT-OUT | not needed: the existing best-effort call is left unchanged; the webhook branch never starts a full sync (D-32) |
| nango.connection-metadata-api | OPT-OUT | not needed: the scope selection is stored on nango_connections in Supabase (D-22) |
