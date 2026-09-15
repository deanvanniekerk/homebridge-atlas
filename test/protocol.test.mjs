import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  armDisarmType,
  classifyError,
  decodeArmStates,
  decodeDetectors,
  decodePanelState,
  envelopeError,
} from "../dist/protocol.js";

const fixture = (name) =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/webui/${name}`, import.meta.url), "utf8"),
  );

test("decodes partitions, arm state and zone conditions from Detectors/Get", () => {
  const [home] = decodeDetectors(fixture("detectors-get.json"));
  assert.equal(home.id, 0);
  assert.equal(home.armState, "disarmed");
  assert.deepEqual(
    home.zones.map(({ name, state, bypassed, trouble }) => [
      name,
      state,
      bypassed,
      trouble,
    ]),
    [
      ["Hall PIR", "closed", false, false],
      ["Front Door", "open", false, false],
      ["Kitchen PIR", "closed", true, false],
      ["Garden Beam", "closed", false, true],
    ],
  );
});

test("reports unrecognised detector filters and arm icons as unknown", () => {
  const body = fixture("detectors-get.json");
  body.detectors.parts[0].armIcon = "/Content/images/ico-new.png";
  body.detectors.parts[0].detectors[0].filter = "masked";
  const [home] = decodeDetectors(body);
  assert.equal(home.armState, "unknown");
  assert.equal(home.zones[0].state, "unknown");
});

test("maps the System pseudo partition to a null id", () => {
  const body = fixture("detectors-get.json");
  body.detectors.parts[0].id = -1;
  assert.equal(decodeDetectors(body)[0].id, null);
});

test("rejects detector payloads with missing fields", () => {
  const body = fixture("detectors-get.json");
  delete body.detectors.parts[0].detectors[1].bypassed;
  assert.throws(() => decodeDetectors(body), {
    code: "protocol",
    field: "detector.bypassed",
  });
});

test("treats an unchanged GetCPState poll as carrying no arm or detector data", () => {
  const state = decodePanelState(fixture("getcpstate-unchanged.json"));
  assert.equal(state.offline, false);
  assert.equal(state.ongoingAlarm, false);
  assert.equal(state.memoryAlarm, true);
  assert.deepEqual(state.exitDelaySeconds, [0]);
  assert.equal(state.armStates, undefined);
  assert.equal(state.partitions, undefined);
});

test("decodes changed arm states and detectors from GetCPState", () => {
  const body = fixture("getcpstate-unchanged.json");
  body.strResult = "AA:PPP";
  body.ExitDelayTimeout = [-3];
  body.detectors = fixture("detectors-get.json").detectors;
  const state = decodePanelState(body);
  assert.deepEqual(state.armStates, ["armed"]);
  assert.deepEqual(state.exitDelaySeconds, [0]);
  assert.equal(state.partitions?.[0]?.zones.length, 4);
});

test("decodes per-partition characters after the summary character", () => {
  assert.deepEqual(decodeArmStates("PDAPX:"), [
    "disarmed",
    "armed",
    "partial",
    "unknown",
  ]);
  assert.throws(() => decodeArmStates("DD"), { code: "protocol" });
});

test("classifies web UI error codes like the web UI does", () => {
  assert.equal(envelopeError(fixture("overview-get.json")), 0);
  assert.equal(classifyError(0), "ok");
  assert.equal(classifyError(72), "pending");
  assert.equal(classifyError(17), "pending");
  assert.equal(classifyError(22), "site-session-expired");
  assert.equal(classifyError(501), "user-session-expired");
  assert.equal(classifyError(5001), "pin-changed");
  assert.equal(classifyError(14), "pin-rejected");
  assert.equal(classifyError(26), "panel-unreachable");
  assert.equal(classifyError(28), "rejected");
});

test("builds ArmDisarm command types without sending anything", () => {
  assert.equal(armDisarmType(0, "armed"), "0:armed");
  assert.equal(armDisarmType(0, "partial"), "0:partially");
  assert.equal(armDisarmType(1, "disarmed"), "1:disarmed");
  assert.throws(() => armDisarmType(-1, "armed"), { code: "configuration" });
});
