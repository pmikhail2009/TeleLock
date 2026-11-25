import { fullAccess, staffAccess } from '../serverless/tgcloud/lib/controls.js';

export { fullAccess, staffAccess };
export const allowedCommand = (tier, action) => fullAccess(tier) || ['/play_normal','/play_ranked','/play_street'].includes(action);
