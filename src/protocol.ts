import { AtlasError } from "./errors.js";

// Pure decoders for the RISCO Cloud web UI (webui.riscocloud.com) JSON
// endpoints. Shapes are documented in docs/research/riscocloud-webui-api.md.

export type ArmState = "disarmed" | "partial" | "armed";
export type ZoneState = "closed" | "open" | "unknown";

export interface Zone {
  id: number;
  name: string;
  state: ZoneState;
  bypassed: boolean;
  trouble: boolean;
}

export interface Partition {
  /** Panel partition id; `null` for the pseudo "System" group (id < 0). */
  id: number | null;
  name: string;
  armState: ArmState | "unknown";
  zones: Zone[];
}

export interface PanelState {
  offline: boolean;
  ongoingAlarm: boolean;
  memoryAlarm: boolean;
  exitDelaySeconds: number[];
  /** Per partition index, present only when the panel reports a change. */
  armStates: (ArmState | "unknown")[] | undefined;
  /** Present only when detector data changed since the previous poll. */
  partitions: Partition[] | undefined;
}

/**
 * How a non-zero `error` in a web UI envelope should be handled. Mirrors
 * `HandleErrorCode` and `RefreshAll` in the web UI scripts.
 */
export type PanelOutcome =
  | "ok"
  | "pending"
  | "site-session-expired"
  | "user-session-expired"
  | "pin-changed"
  | "pin-rejected"
  | "panel-unreachable"
  | "rejected";

export function record(
  value: unknown,
  field?: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new AtlasError("protocol", field);
  return value as Record<string, unknown>;
}

function list(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new AtlasError("protocol", field);
  return value;
}

function integer(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value))
    throw new AtlasError("protocol", field);
  return value;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") throw new AtlasError("protocol", field);
  return value;
}

function flag(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new AtlasError("protocol", field);
  return value;
}

export function envelopeError(body: unknown): number {
  return integer(record(body).error, "error");
}

export function classifyError(code: number): PanelOutcome {
  switch (code) {
    case 0:
      return "ok";
    case 17:
    case 72:
      return "pending";
    case 1:
    case 2:
    case 3:
    case 4:
    case 10:
    case 22:
    case 51:
    case 55:
    case 500:
      return "site-session-expired";
    case 501:
      return "user-session-expired";
    case 5001:
      return "pin-changed";
    case 14:
      return "pin-rejected";
    case 26:
      return "panel-unreachable";
    default:
      return "rejected";
  }
}

const armIcons: Record<string, ArmState> = {
  "ico-disarmed.png": "disarmed",
  "ico-partial.png": "partial",
  "ico-armed.png": "armed",
};

function armStateFromIcon(icon: string): ArmState | "unknown" {
  return armIcons[icon.slice(icon.lastIndexOf("/") + 1)] ?? "unknown";
}

function decodeZone(value: unknown): Zone {
  const row = record(value, "detector");
  const bypassed = flag(row.bypassed, "detector.bypassed");
  const filter = text(row.filter, "detector.filter");
  const state: ZoneState =
    filter === "triggered"
      ? "open"
      : filter === "" || filter === "bypassed"
        ? "closed"
        : "unknown";
  return {
    id: integer(row.id, "detector.id"),
    name: text(row.name, "detector.name"),
    state,
    bypassed,
    trouble: text(row.classAttrib, "detector.classAttrib")
      .split(/\s+/)
      .includes("error"),
  };
}

export function decodeDetectors(value: unknown): Partition[] {
  const parts = list(
    record(record(value).detectors, "detectors").parts,
    "detectors.parts",
  );
  return parts.map((part) => {
    const row = record(part, "part");
    const id = integer(row.id, "part.id");
    return {
      id: id < 0 ? null : id,
      name: text(row.name, "part.name"),
      armState: armStateFromIcon(text(row.armIcon, "part.armIcon")),
      zones: list(row.detectors, "part.detectors").map(decodeZone),
    };
  });
}

const stateChars: Record<string, ArmState> = {
  D: "disarmed",
  P: "partial",
  A: "armed",
};

/**
 * `strResult` is `"<summary><partition 0><partition 1>...:<groups>"`. The web UI
 * maps character j (j >= 1) onto radio group `SecSelect{j-1}`; character 0 has
 * no partition control and is ignored.
 */
export function decodeArmStates(strResult: string): (ArmState | "unknown")[] {
  const colon = strResult.indexOf(":");
  if (colon < 0) throw new AtlasError("protocol", "strResult");
  return [...strResult.slice(1, colon)].map((c) => stateChars[c] ?? "unknown");
}

export function decodePanelState(value: unknown): PanelState {
  const row = record(value);
  const strResult = row.strResult;
  const detectors = row.detectors;
  return {
    offline: flag(row.IsOffline, "IsOffline"),
    ongoingAlarm: flag(row.OngoingAlarm, "OngoingAlarm"),
    memoryAlarm: flag(row.MemoryAlarm, "MemoryAlarm"),
    exitDelaySeconds:
      row.ExitDelayTimeout === undefined || row.ExitDelayTimeout === null
        ? []
        : list(row.ExitDelayTimeout, "ExitDelayTimeout").map((n) =>
            Math.max(0, integer(n, "ExitDelayTimeout")),
          ),
    armStates:
      typeof strResult === "string" && strResult.includes(":")
        ? decodeArmStates(strResult)
        : undefined,
    partitions:
      detectors === null || detectors === undefined
        ? undefined
        : decodeDetectors({ detectors }),
  };
}

const commandSuffix: Record<ArmState, string> = {
  disarmed: "disarmed",
  partial: "partially",
  armed: "armed",
};

/** Builds the `type` form field for `POST /Security/ArmDisarm`. */
export function armDisarmType(
  partitionIndex: number,
  target: ArmState,
): string {
  if (!Number.isInteger(partitionIndex) || partitionIndex < 0)
    throw new AtlasError("configuration", "partitionIndex");
  return `${partitionIndex}:${commandSuffix[target]}`;
}
