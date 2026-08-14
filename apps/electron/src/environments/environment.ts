export const environment = {
  // TODO: REPLACE WITH PROD KEY
  //
  // Development key. Two things to know when the production one arrives:
  //   1. Dev keys expire every 24 hours, so Riot-backed features stop working
  //      until this is refreshed. That is why the rank recorder is written to
  //      skip a pass rather than fail when a key is rejected.
  //   2. Swapping the key alone does NOT unlock production throughput — the
  //      limiter in apps/electron/rate-limiter.js is hardcoded to dev limits
  //      and will keep pacing at ~0.83 req/s. See the TODO there.
  riotApiKey: 'RGAPI-eab67407-e4c0-4516-a7e8-850957aedabe',
  firebaseConfig: {
    apiKey: 'AIzaSyDjB0kRJrBWL8exTK-AqpAEInBJbFJXlwM',
    authDomain: 'lolvault.firebaseapp.com',
    projectId: 'lolvault',
    storageBucket: 'lolvault.firebasestorage.app',
    messagingSenderId: '142333149862',
    appId: '1:142333149862:web:2ef3d8432cd15dc1606a67',
    measurementId: 'G-4YPNP4500P',
  },
};
