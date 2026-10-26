# CVS SME Signed Bridge

Source for the signed Apps Script bridge. The bridge is bound to SME_CVS_BKK and handles field-level sync. Credentials are stored separately in Cloudflare and Google ScriptProperties.

Notes: direct spreadsheet edits are monitored by the installed onEdit trigger. Edits by external programs must send trusted field change timestamps separately. See FIELD_LEVEL_LWW_2026-10-26.md in the repo.
