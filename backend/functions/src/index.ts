import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';

admin.initializeApp();

// Example Cloud Function - you can remove or modify this
export const helloWorld = functions.https.onRequest((request, response) => {
  functions.logger.info('Hello logs!', { structuredData: true });
  response.send('Hello from LoL Vault!');
});

// Add your Cloud Functions here
// Example:
// export const onUserCreated = functions.auth.user().onCreate((user) => {
//   // Handle new user creation
// });
