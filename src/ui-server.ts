import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';
import { CloudError } from './cloud/cloud-error.js';
import { discoverZones } from './site/setup.js';

class UiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.onRequest('/zones', async (input: unknown) => {
      try {
        return await discoverZones(input);
      } catch (error) {
        const safe = error instanceof CloudError ? error : new CloudError('unavailable');
        throw new RequestError(safe.message, { code: safe.category });
      }
    });
    this.ready();
  }
}

new UiServer();
