const messages = {
  oauth_scopes_invalid:
    "The provider scope list is malformed or exceeds the complete local disclosure limit. No credential was accepted; reconnect only after resolving the scope format.",
  oauth_scopes_missing:
    "Required permissions are missing. Return to Connections to view the local scope disclosure; additional permissions cannot replace missing requirements.",
  oauth_scope_consent_invalid:
    "Scope approval is unavailable, expired or does not match this browser and exact disclosure. No additional capabilities were accepted.",
  oauth_scopes_changed:
    "Refresh changed the accepted credential capabilities or removed required permissions. Explicit reconnect and scope review are required.",
};

export class OAuthScopeError extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
  }
}

export function localScopeAdmission(profileId: string): boolean {
  return [
    "slack-mcp/1",
    "linear-mcp/1",
    "axiom-mcp/1",
    "notion-mcp/1",
  ].includes(profileId);
}

export function decodeOAuthScopes(profileId: string, value: string): string[] {
  if (!localScopeAdmission(profileId))
    return value.split(/\s+/).filter(Boolean);
  if (value.length > 8192 || /[^\x20-\x7e\t\r\n]/.test(value))
    throw new OAuthScopeError("oauth_scopes_invalid");
  const items = value
    .split(profileId === "slack-mcp/1" ? /[, \t\r\n]+/ : / +/)
    .filter(Boolean);
  if (
    items.length > 128 ||
    items.some(
      (item) =>
        !(
          profileId === "slack-mcp/1"
            ? /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/
            : /^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/
        ).test(item),
    )
  )
    throw new OAuthScopeError("oauth_scopes_invalid");
  return [...new Set(items)];
}
