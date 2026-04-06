export const DAEMON_SOCKET_PROTOCOL_VERSION = 1;

export const DAEMON_SOCKET_PROTOCOL_RESTART_INSTRUCTION =
  "Restart the daemon with `forge daemon restart` after upgrading Forge.";

export const formatDaemonProtocolMismatchMessage = (input: {
  readonly clientProtocolVersion: number;
  readonly daemonProtocolVersion: number;
}) =>
  [
    "Forge daemon protocol version mismatch.",
    `CLI protocol=${input.clientProtocolVersion}, daemon protocol=${input.daemonProtocolVersion}.`,
    DAEMON_SOCKET_PROTOCOL_RESTART_INSTRUCTION,
  ].join(" ");

export const formatDaemonProtocolHandshakeMissingMessage = () =>
  [
    "Forge daemon protocol version handshake is required for socket RPCs.",
    DAEMON_SOCKET_PROTOCOL_RESTART_INSTRUCTION,
  ].join(" ");
