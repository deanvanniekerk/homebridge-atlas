import { z } from 'zod';
import { CloudError } from './cloud-error.js';

export interface Credentials {
  username: string;
  password: string;
  pin: string;
  /** Required only when the account can see more than one site. */
  siteId?: number;
}
export interface Site {
  id: number;
  name: string;
}
export interface Session {
  token: string;
  siteId: number;
  sessionId: string;
}
/** Vendor `armedState` values accepted by `ControlPanel/PartArm`. */
export type ArmTarget = 'disarmed' | 'partial' | 'armed';

const vendorOrigin = 'https://www.riscocloud.com';
const prefix = '/webapi/api/';

export const paths = {
  login: `${prefix}auth/login`,
  sites: `${prefix}wuws/site/GetAll`,
  siteLogin: (siteId: number) => `${prefix}wuws/site/${String(siteId)}/Login`,
  state: (siteId: number) => `${prefix}wuws/site/${String(siteId)}/ControlPanel/GetState`,
  arm: (siteId: number) => `${prefix}wuws/site/${String(siteId)}/ControlPanel/PartArm`,
  events: (siteId: number) => `${prefix}wuws/site/${String(siteId)}/ControlPanel/sse/connect`,
};

export function originFor(value = vendorOrigin): string {
  try {
    const url = new URL(value);
    if (
      value !== url.origin ||
      (value !== vendorOrigin &&
        !(
          ['http:', 'https:'].includes(url.protocol) &&
          ['127.0.0.1', '[::1]'].includes(url.hostname)
        ))
    )
      throw new Error();
    return value;
  } catch {
    throw new CloudError('invalid-request');
  }
}

const nonBlankText = (maximum: number) =>
  z.string().refine((value) => value.trim().length > 0 && Array.from(value).length <= maximum);
const identifier = z.number().int().nonnegative().refine(Number.isSafeInteger);
const credentialsSchema = z.object({
  username: nonBlankText(320),
  password: nonBlankText(4096),
  pin: z.string().regex(/^\d{4,8}$/),
  siteId: identifier.optional(),
});
const tokenSchema = nonBlankText(8192).regex(/^[\x21-\x7e]+$/);
const siteSchema = z.object({ id: identifier, name: z.string() });
const armTargetSchema = z.enum(['disarmed', 'partial', 'armed']);

export function credentialsFor(value: Credentials): Credentials {
  const result = credentialsSchema.safeParse(value);
  if (!result.success) throw new CloudError('invalid-request');
  return {
    username: result.data.username,
    password: result.data.password,
    pin: result.data.pin,
    ...(result.data.siteId === undefined ? {} : { siteId: result.data.siteId }),
  };
}

export function accessTokenFrom(value: unknown): string {
  const result = z.object({ accessToken: tokenSchema }).safeParse(value);
  if (!result.success) throw new CloudError('invalid-response');
  return result.data.accessToken;
}

export function sitesFrom(value: unknown): Site[] {
  const result = z.array(siteSchema).max(100).safeParse(value);
  if (!result.success) throw new CloudError('invalid-response');
  return result.data;
}

/** An explicit site must exist; otherwise the account must expose exactly one. */
export function selectSite(sites: Site[], siteId: number | undefined): Site {
  const site =
    siteId === undefined
      ? sites.length === 1
        ? sites[0]
        : undefined
      : sites.find((candidate) => candidate.id === siteId);
  if (!site) throw new CloudError('site-selection');
  return site;
}

export function sessionIdFrom(value: unknown): string {
  const result = z.object({ sessionId: tokenSchema }).safeParse(value);
  if (!result.success) throw new CloudError('invalid-response');
  return result.data.sessionId;
}

export function siteLoginBody(pin: string): { languageId: string; pinCode: string } {
  return { languageId: 'en', pinCode: pin };
}

/** Vendor timestamps without a zone designator are UTC. Unparseable values are ignored. */
export function vendorTime(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length > 64) return undefined;
  const text = /[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`;
  const time = Date.parse(text);
  return Number.isFinite(time) ? time : undefined;
}

export function stateBody(
  session: Session,
  fromControlPanel: boolean,
): { fromControlPanel: boolean; sessionToken: string } {
  return { fromControlPanel, sessionToken: session.sessionId };
}

const armedStates: Record<ArmTarget, number> = { disarmed: 1, partial: 2, armed: 3 };

export interface ArmCommand {
  partitions: { id: number; armedState: number }[];
}

/** Validate and snapshot caller input before any authentication or backoff wait. */
export function armCommand(partitionId: number, target: ArmTarget): ArmCommand {
  if (!identifier.safeParse(partitionId).success || !armTargetSchema.safeParse(target).success)
    throw new CloudError('invalid-request');
  return { partitions: [{ id: partitionId, armedState: armedStates[target] }] };
}

export function armBody(
  session: Session,
  command: ArmCommand,
): ArmCommand & { fromControlPanel: boolean; sessionToken: string } {
  return { ...command, fromControlPanel: true, sessionToken: session.sessionId };
}
