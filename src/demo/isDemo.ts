/**
 * The website's live demo (`vite build --mode demo`): the real frontend on the mocked backend.
 * A build-time constant, so everything behind it is dropped from the desktop and mock builds.
 */
export const isDemo = import.meta.env.VITE_DEMO === '1';
