export const getPhaseSlug = (p) => 'ph-' + (p || 'idle').toLowerCase().replace(/[^a-z0-9]+/g, '-');
