import type {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge';
import { RiscoClient } from './cloud-client.js';
import { isRecord } from './cloud-error.js';
import {
  ConfigurationError,
  parseConfig,
  sensorKindFor,
  type AtlasConfig,
  type SensorKind,
} from './configuration.js';
import { SiteCoordinator, type SiteSnapshot } from './coordinator.js';
import { Diagnostics } from './diagnostics.js';
import { AtlasGateway } from './gateway.js';
import { SecuritySystem } from './security-system.js';
import { PLATFORM_NAME, PLUGIN_NAME, pluginVersion } from './settings.js';
import { ZoneSensor } from './zone-sensor.js';

type Accessory = PlatformAccessory<Record<string, unknown>>;
type Kind = 'partition' | 'zone';
interface Identity {
  siteId: number;
  kind: Kind;
  id: number;
}

const hints: Readonly<Record<string, string>> = {
  'invalid-credentials': 'Check the username and password, then restart.',
  'invalid-pin': 'Check the panel user code, then restart. Traffic is paused.',
  'site-selection': 'Set the site ID for this account, then restart.',
  'permission-denied': 'Check that this user may access the site.',
  'session-contention': 'Another client may be signing in with this account; cooling down.',
  'invalid-response': 'The cloud response did not match the supported protocol.',
  unconfirmed: 'The panel did not report the requested arm state in time.',
};

function identityOf(context: unknown): Identity | undefined {
  if (
    !isRecord(context) ||
    !Number.isSafeInteger(context.siteId) ||
    !Number.isSafeInteger(context.id) ||
    (context.kind !== 'partition' && context.kind !== 'zone')
  )
    return undefined;
  return { siteId: context.siteId as number, kind: context.kind, id: context.id as number };
}

/** HAP names allow letters, digits, spaces and apostrophes, starting and ending alphanumeric. */
function displayName(value: string, fallback: string): string {
  const cleaned = value
    .replace(/[^\p{L}\p{N} ']/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  return cleaned.length > 0 ? cleaned.slice(0, 64) : fallback;
}

/** Owns Homebridge lifecycle and stable identity; cloud scheduling belongs to the coordinator. */
export class AtlasPlatform implements DynamicPlatformPlugin {
  readonly #api: API;
  readonly #log: Logger;
  readonly #accessories = new Map<
    string,
    { accessory: Accessory; presentation: SecuritySystem | ZoneSensor }
  >();
  readonly #shutdown = new AbortController();
  readonly #config: AtlasConfig | undefined;
  readonly #coordinator: SiteCoordinator | undefined;
  readonly #diagnostics: Diagnostics | undefined;
  #started = false;
  #logged: { signature: string; fault: boolean } | undefined;
  #warnedRejected = false;

  constructor(log: Logger, config: PlatformConfig, api: API) {
    this.#api = api;
    this.#log = log;
    api.on('shutdown', () => {
      this.#shutdown.abort();
      this.#coordinator?.close();
      for (const entry of this.#accessories.values()) entry.presentation.close();
      this.#accessories.clear();
    });
    try {
      this.#config = parseConfig(config);
      const gateway = new AtlasGateway(
        new RiscoClient({
          username: this.#config.username,
          password: this.#config.password,
          pin: this.#config.pin,
          ...(this.#config.siteId === undefined ? {} : { siteId: this.#config.siteId }),
        }),
      );
      this.#diagnostics = new Diagnostics(
        (message) => {
          log.info(message);
        },
        {
          pluginVersion: pluginVersion(),
          homebridgeVersion: api.serverVersion,
          debug: this.#config.debug,
          rejectedShape: () => gateway.rejectedShape(),
          readStats: () => gateway.readStats(),
        },
      );
      this.#coordinator = new SiteCoordinator(gateway, {
        intervalMs: this.#config.pollInterval * 1000,
      });
    } catch (error) {
      const message =
        error instanceof ConfigurationError ? error.message : 'Unable to initialize the platform.';
      log.error(`Configuration rejected: ${message}`);
      return;
    }
    api.on('didFinishLaunching', () => {
      if (this.#started || this.#shutdown.signal.aborted) return;
      this.#started = true;
      void this.consume();
    });
  }

  configureAccessory(accessory: Accessory): void {
    if (this.#shutdown.signal.aborted || this.#accessories.has(accessory.UUID)) return;
    // Persist identity and presentation choice only, never panel state or account credentials.
    const identity = identityOf(accessory.context);
    const verified = identity && this.uuid(identity) === accessory.UUID ? identity : undefined;
    const sensor: SensorKind =
      isRecord(accessory.context) && accessory.context.sensor === 'motion' ? 'motion' : 'contact';
    const kind = identity?.kind ?? 'zone';
    accessory.context = identity
      ? { ...identity, ...(kind === 'zone' ? { sensor } : {}) }
      : { kind };
    const presentation =
      kind === 'partition'
        ? new SecuritySystem(this.#api.hap, accessory, this.#coordinator, verified?.id, {
            control: this.#config?.enableControl === true,
            partialArmMode: this.#config?.partialArmMode ?? 'stay',
          })
        : new ZoneSensor(this.#api.hap, accessory, this.#coordinator, verified?.id, sensor);
    this.#accessories.set(accessory.UUID, { accessory, presentation });
  }

  private uuid(identity: Identity): string {
    return this.#api.hap.uuid.generate(
      `${PLUGIN_NAME}:site:${String(identity.siteId)}:${identity.kind}:${String(identity.id)}`,
    );
  }

  private async consume(): Promise<void> {
    try {
      if (!this.#coordinator) return;
      this.#coordinator.start();
      this.#log.info(
        `Atlas monitoring started (plugin ${pluginVersion()}); arming and disarming ${
          this.#config?.enableControl ? 'enabled' : 'disabled'
        }.`,
      );
      for await (const snapshot of this.#coordinator.updates(this.#shutdown.signal))
        this.synchronize(snapshot);
    } catch {
      if (!this.#shutdown.signal.aborted) {
        this.#log.error('Accessory updates stopped unexpectedly. Restart the platform to retry.');
        this.#shutdown.abort();
        this.#coordinator?.close();
        for (const entry of this.#accessories.values()) entry.presentation.close();
      }
    }
  }

  private wanted(identity: Identity, siteId: number): SensorKind | 'partition' | undefined {
    const config = this.#config;
    if (!config || identity.siteId !== siteId) return undefined;
    if (identity.kind === 'partition') return 'partition';
    if (!config.includeZones) return undefined;
    const override = config.zones.get(identity.id);
    if (override === 'hidden') return undefined;
    const zone = this.#coordinator?.snapshot().panel?.zones.find((item) => item.id === identity.id);
    return override ?? (zone ? sensorKindFor(zone.name) : undefined);
  }

  private synchronize(snapshot: SiteSnapshot): void {
    this.report(snapshot);
    this.#diagnostics?.observe(snapshot);
    const panel = snapshot.panel;
    if (!panel) {
      for (const entry of this.#accessories.values()) entry.presentation.update();
      return;
    }
    const candidates: { identity: Identity; name: string }[] = [
      ...panel.partitions.map((partition) => ({
        identity: { siteId: panel.siteId, kind: 'partition' as const, id: partition.id },
        name:
          panel.partitions.length === 1
            ? (this.#config?.name ?? 'Atlas')
            : `${this.#config?.name ?? 'Atlas'} Partition ${String(partition.id + 1)}`,
      })),
      ...panel.zones.map((zone) => ({
        identity: { siteId: panel.siteId, kind: 'zone' as const, id: zone.id },
        name: zone.name,
      })),
    ];
    // Retire other sites and hidden zones; keep transient omissions. Sensor type changes keep identity.
    for (const [uuid, entry] of this.#accessories) {
      const identity = identityOf(entry.accessory.context);
      if (!identity || this.uuid(identity) !== uuid) continue;
      const wanted = this.wanted(identity, panel.siteId);
      const present = candidates.some(
        (candidate) =>
          candidate.identity.kind === identity.kind && candidate.identity.id === identity.id,
      );
      if (wanted === undefined && (present || identity.siteId !== panel.siteId)) {
        this.#api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [entry.accessory]);
        entry.presentation.close();
        this.#accessories.delete(uuid);
      } else if (
        identity.kind === 'zone' &&
        (wanted === 'motion' || wanted === 'contact') &&
        entry.accessory.context.sensor !== wanted
      ) {
        entry.presentation.close();
        entry.accessory.context = { ...identity, sensor: wanted };
        entry.presentation = new ZoneSensor(
          this.#api.hap,
          entry.accessory,
          this.#coordinator,
          identity.id,
          wanted,
        );
        this.#api.updatePlatformAccessories([entry.accessory]);
      }
    }
    for (const { identity, name } of candidates) {
      const wanted = this.wanted(identity, panel.siteId);
      const uuid = this.uuid(identity);
      if (wanted === undefined || this.#accessories.has(uuid)) continue;
      try {
        const accessory = new this.#api.platformAccessory(
          displayName(name, identity.kind === 'zone' ? `Zone ${String(identity.id)}` : 'Atlas'),
          uuid,
        );
        accessory.context = { ...identity, ...(wanted === 'partition' ? {} : { sensor: wanted }) };
        const C = this.#api.hap.Characteristic;
        accessory
          .getService(this.#api.hap.Service.AccessoryInformation)
          ?.setCharacteristic(C.Manufacturer, 'RISCO')
          .setCharacteristic(C.Model, identity.kind === 'partition' ? 'Partition' : 'Zone')
          .setCharacteristic(C.SerialNumber, uuid);
        this.configureAccessory(accessory);
        this.#api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      } catch {
        const entry = this.#accessories.get(uuid);
        try {
          if (entry)
            this.#api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [entry.accessory]);
        } catch {
          /* The host removes the cache entry even if HAP attachment never happened. */
        }
        entry?.presentation.close();
        this.#accessories.delete(uuid);
        this.#log.warn('An accessory could not be registered; retrying on the next update.');
      }
    }
    for (const entry of this.#accessories.values()) entry.presentation.update();
  }

  private report(snapshot: SiteSnapshot): void {
    if (snapshot.panel && snapshot.panel.rejectedRecords > 0 && !this.#warnedRejected) {
      this.#warnedRejected = true;
      this.#log.warn(
        `${String(snapshot.panel.rejectedRecords)} partition or zone records were ignored because their identity was missing or duplicated.`,
      );
    }
    // The initial empty snapshot is neither failure nor recovery evidence.
    if (snapshot.status === 'unavailable' && snapshot.failure === undefined) return;
    const fault = snapshot.status !== 'healthy' || snapshot.failure !== undefined;
    const signature = `${snapshot.status}/${snapshot.failure ?? 'none'}/${String(snapshot.failureCode)}`;
    if (this.#logged?.signature === signature) return;
    const previous = this.#logged;
    this.#logged = { signature, fault };
    if (!fault) {
      if (previous?.fault) this.#log.info('Atlas site recovered; fresh panel state available.');
      return;
    }
    const hint = snapshot.failure === undefined ? '' : ` ${hints[snapshot.failure] ?? ''}`;
    const code =
      snapshot.failureCode === undefined ? '' : ` (vendor result ${String(snapshot.failureCode)})`;
    this.#log.warn(
      `Atlas site ${snapshot.status}; ${snapshot.failure ?? 'no cloud failure'}${code}.${hint}`.trimEnd(),
    );
  }
}
