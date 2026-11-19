export const fullAccess = tier => tier === 'owner' || tier === 'test';
export const allowedCommand = (tier, action) => fullAccess(tier) || ['/play_normal','/play_ranked','/play_street'].includes(action);
