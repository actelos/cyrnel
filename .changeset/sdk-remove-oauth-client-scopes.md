---
"@cyrnel/sdk": major
---

**BREAKING** Remove `OAuthClient.availableScopes`.

OAuth clients no longer carry a scope allow-list. Scopes now flow from
service/module-declared scopes to user-requested scopes to provider-granted
scopes:

- `OAuthClient` drops the required `availableScopes` field entirely.
- The host validates requested scopes against the credential scheme's
  declared scopes (warning for undeclared scopes) instead of a
  client-level allow-list.
- The resolve endpoint reports authorization/token endpoint compatibility
  with a human-readable reason; scope compatibility is evaluated when a
  client is linked to a specific credential scheme.

### Migration

- Stop passing `availableScopes` when registering OAuth clients; delete the
  field from any stored fixtures or mocks.
- Derive scope choices from the service/module `schemes` declarations
  instead of the removed client field.
