export const type = "openclaw_gateway";
export const label = "OpenClaw Gateway";

export const models: { id: string; label: string }[] = [];

export const agentConfigurationDoc = `# openclaw_gateway config

Core fields:
- url (string, required): WebSocket URL (ws:// or wss://)
- headers (object, optional): handshake headers
- authToken, password (string, optional)

Identity:
- clientId, clientMode, clientVersion, role, scopes (optional)
- disableDeviceAuth (boolean, optional): default false

Behavior:
- payloadTemplate, workspaceRuntime (object, optional)
- timeoutSec (number, optional): default 120
- waitTimeoutMs (number, optional)
- autoPairOnFirstConnect (boolean, optional): default true
- paperclipApiUrl, claimedApiKeyPath (string, optional)

Session:
- sessionKeyStrategy (string, optional): issue|fixed|run
- sessionKey (string, optional): default "paperclip"
`;
