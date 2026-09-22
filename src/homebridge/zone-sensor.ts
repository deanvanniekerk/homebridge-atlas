import type { API, Characteristic, PlatformAccessory } from 'homebridge';
import type { SensorKind } from '../configuration.js';
import type { SiteCoordinator } from '../site/coordinator.js';

/** Read-only HAP presentation of one zone as a motion or contact sensor. */
export class ZoneSensor {
  readonly #hap: API['hap'];
  readonly #coordinator: SiteCoordinator | undefined;
  readonly #id: number | undefined;
  readonly #bindings: { characteristic: Characteristic; read: () => number | boolean }[] = [];
  #closed = false;

  constructor(
    hap: API['hap'],
    accessory: PlatformAccessory<Record<string, unknown>>,
    coordinator: SiteCoordinator | undefined,
    zoneId: number | undefined,
    kind: SensorKind,
  ) {
    this.#hap = hap;
    this.#coordinator = coordinator;
    this.#id = zoneId;
    const C = hap.Characteristic;
    const [serviceType, staleType] =
      kind === 'motion'
        ? [hap.Service.MotionSensor, hap.Service.ContactSensor]
        : [hap.Service.ContactSensor, hap.Service.MotionSensor];
    // A per-zone type override replaces the cached service rather than adding a second one.
    const stale = accessory.getService(staleType);
    if (stale) accessory.removeService(stale);
    const service =
      accessory.getService(serviceType) ?? accessory.addService(serviceType, accessory.displayName);

    if (kind === 'motion')
      this.bind(
        service.getCharacteristic(C.MotionDetected),
        () => this.condition() === 'triggered',
      );
    else
      this.bind(service.getCharacteristic(C.ContactSensorState), () =>
        this.condition() === 'triggered'
          ? C.ContactSensorState.CONTACT_NOT_DETECTED
          : C.ContactSensorState.CONTACT_DETECTED,
      );
    // A bypassed zone is not monitored by the panel, so its reported condition is not evidence.
    this.bind(service.getCharacteristic(C.StatusActive), () => this.condition() !== 'bypassed');
    // A zone trouble flag, or the panel being offline from RISCO Cloud, is shown as a fault.
    this.bind(service.getCharacteristic(C.StatusFault), () => {
      const zone = this.zone();
      const offline = this.#coordinator?.snapshot().offline === true;
      return offline || (zone.trouble.available && zone.trouble.value)
        ? C.StatusFault.GENERAL_FAULT
        : C.StatusFault.NO_FAULT;
    });
    this.update();
  }

  update(): void {
    for (const { characteristic, read } of this.#bindings) {
      try {
        characteristic.updateValue(read());
      } catch {
        characteristic.updateValue(this.unavailable());
      }
    }
  }

  close(): void {
    this.#closed = true;
    this.update();
  }

  private bind(characteristic: Characteristic, read: () => number | boolean): void {
    const guarded = () => {
      if (this.#closed) throw this.unavailable();
      return read();
    };
    characteristic.onGet(guarded);
    this.#bindings.push({ characteristic, read: guarded });
  }

  private zone() {
    const zone =
      this.#closed || this.#id === undefined ? undefined : this.#coordinator?.zone(this.#id);
    if (!zone) throw this.unavailable();
    return zone;
  }

  private condition() {
    const zone = this.zone();
    if (!zone.condition.available) throw this.unavailable();
    return zone.condition.value;
  }

  private unavailable() {
    const {
      HAPStatus: { SERVICE_COMMUNICATION_FAILURE },
    } = this.#hap;
    return new this.#hap.HapStatusError(SERVICE_COMMUNICATION_FAILURE);
  }
}
