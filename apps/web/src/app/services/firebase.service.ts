import { Injectable } from '@angular/core';
import { FirebaseApp, initializeApp } from 'firebase/app';
import { Analytics, getAnalytics } from 'firebase/analytics';
import { Auth, getAuth } from 'firebase/auth';
import { Firestore, getFirestore } from 'firebase/firestore';
import { environment } from '../../environments/environment';

@Injectable({
  providedIn: 'root',
})
export class FirebaseService {
  readonly app: FirebaseApp = initializeApp(environment.firebaseConfig);
  readonly analytics: Analytics = getAnalytics(this.app);
  readonly db: Firestore = getFirestore(this.app);
  readonly auth: Auth = getAuth(this.app);
}
