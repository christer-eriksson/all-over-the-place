/* Run All Around – site settings. */
window.RAA = window.RAA || {};
window.RAA.config = {
  // Map background:
  //   'osm'    – openstreetmap.org's own tile servers: fine for development and light personal use,
  //              but their usage policy doesn't allow a commercial app with real traffic.
  //   'stadia' – Stadia Maps (stadiamaps.com): allowed for commercial use on a paid plan. Add the
  //              site's domain under Authentication in the Stadia dashboard; then no key is needed.
  //              localhost works without an account, for testing.
  tiles: 'osm',
  stadiaKey: '',   // only needed where domain authentication can't be used, e.g. a mobile app
};
