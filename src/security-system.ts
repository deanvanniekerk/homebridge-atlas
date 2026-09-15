import type { API, Characteristic, PlatformAccessory } from 'homebridge';
import { CloudError } from './cloud-error.js';
import { CommandError, type SiteCoordinator } from './coordinator.js';
import type { ArmState } from './panel-model.js';

export interface SecuritySystemOptions {
  readonly control: boolean;
  readonly partialArmMode: 'stay' | 'night';
}

/** HAP presentation of one partition: freshness, commands and vendor meaning belong upstream. */
export class SecuritySystem {
  readonly #hap: API['hap'];
  readonly #coordinator: SiteCoordinator | undefined;
  readonly #id: number | undefined;
  readonly #options: SecuritySystemOptions;
  readonly #bindings: { characteristic: Characteristic; read: () => number }[] = [];
  #closed = false;

  constructor(
    hap: API['hap'],
    accessory: PlatformAccessory<Record<string, unknown>>,
    coordinator: SiteCoordinator | undefined,
    partitionId: number | undefined,
    options: SecuritySystemOptions,
  ) {
    this.#hap = hap;
    this.#coordinator = coordinator;
    this.#id = partitionId;
    this.#options = options;
    const C = hap.Characteristic;
    const service =
      accessory.getService(hap.Service.SecuritySystem) ??
      accessory.addService(hap.Service.SecuritySystem, accessory.displayName);
    const partial =
      options.partialArmMode === 'night'
        ? C.SecuritySystemTargetState.NIGHT_ARM
        : C.SecuritySystemTargetState.STAY_ARM;
    const targets = new Map<ArmState, number>([
      ['disarmed', C.SecuritySystemTargetState.DISARM],
      ['partial', partial],
      ['armed', C.SecuritySystemTargetState.AWAY_ARM],
    ]);

    this.bind(service.getCharacteristic(C.SecuritySystemCurrentState), () => {
      const partition = this.partition();
      if (partition.alarm.available && partition.alarm.value)
        return C.SecuritySystemCurrentState.ALARM_TRIGGERED;
      if (!partition.arm.available) throw this.status('unavailable');
      // Current and target enumerations share values for the three arm states.
      return this.lookup(targets, partition.arm.value);
    });

    const {
      Perms: { PAIRED_WRITE },
    } = hap;
    const defaults = new C.SecuritySystemTargetState().props;
    const target = service.getCharacteristic(C.SecuritySystemTargetState).setProps({
      perms: options.control
        ? [...defaults.perms]
        : defaults.perms.filter((permission) => permission !== PAIRED_WRITE),
      validValues: [...targets.values()].sort(),
    });
    this.bind(target, () => {
      const pending = this.#coordinator?.snapshot().targets.get(this.#id ?? -1);
      if (pending) return this.lookup(targets, pending);
      const partition = this.partition();
      if (!partition.arm.available) throw this.status('unavailable');
      return this.lookup(targets, partition.arm.value);
    });
    target.onSet(async (value) => {
      if (this.#closed) throw this.status('unavailable');
      if (!this.#options.control) throw this.status('readOnly');
      const requested = [...targets].find(([, hapValue]) => hapValue === value)?.[0];
      if (!requested) throw this.status('invalid');
      if (!this.#coordinator || this.#id === undefined) throw this.status('unavailable');
      try {
        await this.#coordinator.arm(this.#id, requested);
      } catch (error) {
        if (error instanceof CloudError && error.category === 'timeout')
          throw this.status('timeout');
        if (error instanceof CommandError && error.category === 'busy') throw this.status('busy');
        throw this.status('unavailable');
      } finally {
        this.update();
      }
    });

    this.bind(service.getCharacteristic(C.StatusFault), () => {
      this.partition();
      // Cloud-cached state means the panel itself did not answer the latest poll.
      return this.#coordinator?.snapshot().panel?.source === 'cloud'
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
        characteristic.updateValue(this.status('unavailable'));
      }
    }
  }

  close(): void {
    this.#closed = true;
    this.update();
  }

  private bind(characteristic: Characteristic, read: () => number): void {
    const guarded = () => {
      if (this.#closed) throw this.status('unavailable');
      return read();
    };
    characteristic.onGet(guarded);
    this.#bindings.push({ characteristic, read: guarded });
  }

  private partition() {
    const partition =
      this.#closed || this.#id === undefined ? undefined : this.#coordinator?.partition(this.#id);
    if (!partition) throw this.status('unavailable');
    return partition;
  }

  private lookup(values: Map<ArmState, number>, state: ArmState): number {
    const value = values.get(state);
    if (value === undefined) throw this.status('unavailable');
    return value;
  }

  private status(kind: 'unavailable' | 'invalid' | 'readOnly' | 'timeout' | 'busy') {
    const {
      HAPStatus: {
        SERVICE_COMMUNICATION_FAILURE,
        INVALID_VALUE_IN_REQUEST,
        READ_ONLY_CHARACTERISTIC,
        OPERATION_TIMED_OUT,
        RESOURCE_BUSY,
      },
    } = this.#hap;
    const code = {
      unavailable: SERVICE_COMMUNICATION_FAILURE,
      invalid: INVALID_VALUE_IN_REQUEST,
      readOnly: READ_ONLY_CHARACTERISTIC,
      timeout: OPERATION_TIMED_OUT,
      busy: RESOURCE_BUSY,
    }[kind];
    return new this.#hap.HapStatusError(code);
  }
}
