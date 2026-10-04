// Firebase web config for the "Kometa" project (Firebase console → Project
// settings → General → Your apps → Web app → SDK setup and configuration).
// These values are public identifiers, not secrets — Firebase web config is
// meant to ship in client bundles — so it's committed rather than env-gated,
// and works the same on any host.
//
// telemetry.ts stays a no-op if apiKey, appId or measurementId is ever
// blanked out (measurementId only exists while Google Analytics is enabled
// on the project).
export const firebaseConfig = {
  apiKey: 'AIzaSyCZJ_kklnTgQJPWti8OwD2sdDrxCFlF7Rw',
  authDomain: 'common-ground-c1f51.firebaseapp.com',
  projectId: 'common-ground-c1f51',
  storageBucket: 'common-ground-c1f51.firebasestorage.app',
  messagingSenderId: '1058160146105',
  appId: '1:1058160146105:web:8ed4a063f35233a4948d68',
  measurementId: 'G-8BNEKLL20Z',
};
