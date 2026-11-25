# API Coverage — Nango-proxied provider sharing APIs (Google Drive, Dropbox, Notion)

> Full coverage by default. Opt-outs are explicit, reasoned decisions.
>
> Scope: the permission-related capabilities that DATA-22 needs (CONTEXT D-20 to D-22, A-10; RESEARCH section 8). Every call goes through `nango.proxy` on the connection the document was synced with. The app only reads sharing; it never changes it. File listing, download and content calls already exist and are not listed. Plans: `04.3-31` (Google Drive mapper, fail-closed rule, connector service), `04.3-32` (Dropbox and Notion mappers, the five sync loops), `04.3-33` (admin mapping and sharing rules).
>
> Confidence carried from research: Google Drive and Notion are read from the official reference; the Dropbox endpoints and the `sharing.read` scope come from secondary sources and are confirmed by the executor against the official reference before the mapper is written (plan 32, task 1). Any call that fails, including a missing scope, makes the document visible to its uploader and the tenant admins only.

| capability | decision | reason |
|---|---|---|
| google-drive.permissions.list per file (paged with nextPageToken, supportsAllDrives=true, explicit fields) | INTEGRATE | |
| google-drive.permission type user (emailAddress matched to a verified tenant member) | INTEGRATE | |
| google-drive.permission type group (emailAddress as the source group id, mapped through rag_connector_group_map) | INTEGRATE | |
| google-drive.permission type domain (domain sharing rule set by an admin) | INTEGRATE | |
| google-drive.permission type anyone (link sharing rule set by an admin) | INTEGRATE | |
| google-drive.permission role and deleted flag (any role grants read, deleted entries ignored) | INTEGRATE | |
| google-drive.permissionDetails inherited entries on shared drives (counted like direct entries) | INTEGRATE | |
| google-drive.files.permissions inline field on the file listing | OPT-OUT | not needed: it is absent for shared-drive items and for files the connected user cannot share, so permissions.list is the single source |
| google-drive.permissions.get | OPT-OUT | not needed: permissions.list returns every field the mapper reads |
| google-drive.permissions create, update, delete | OPT-OUT | explicitly out of scope: the sync is read-only and never changes sharing at the source |
| google-drive.changes feed for sharing changes | OPT-OUT | not needed: sharing is re-read for every listed file on every sync (D-20); change feeds belong to Phase 6.3 |
| google-workspace.directory group membership expansion | OPT-OUT | explicitly out of scope: source groups map through the admin-maintained table; syncing group membership from identity providers is a deferred idea in CONTEXT.md |
| dropbox.sharing.list_file_members with continue | INTEGRATE | |
| dropbox.sharing.list_folder_members with continue (files inside a shared folder) | INTEGRATE | |
| dropbox member kind user (address matched to a verified tenant member) | INTEGRATE | |
| dropbox member kind group (group id mapped through rag_connector_group_map) | INTEGRATE | |
| dropbox member kind invitee (address matched like a user) | INTEGRATE | |
| dropbox.sharing.list_shared_links (link audience) | OPT-OUT | not needed yet: research verified member listing only; without it a link-shared file is mapped from its listed members, which is narrower than the source and never wider |
| dropbox.team group membership expansion | OPT-OUT | explicitly out of scope: needs team-admin scopes; groups map through the admin-maintained table |
| dropbox.sharing add, update, remove member | OPT-OUT | explicitly out of scope: the sync is read-only |
| notion.page public_url (published to the web, sharing rule set by an admin) | INTEGRATE | |
| notion workspace identity of the connection (workspace mapped to an access group by an admin) | INTEGRATE | |
| notion per-page member or permission listing | OPT-OUT | not available: the public API exposes no sharing or permission field on a page and no permission-listing capability (D-21) |
| notion teamspace membership | OPT-OUT | not available: the public API has no teamspace endpoint; D-21 maps the workspace instead |
| notion.users.list for address matching | OPT-OUT | not needed: with no per-page sharing there is nothing to match users against |
