import { Injectable } from '@angular/core';
import { FirebaseApp, initializeApp } from 'firebase/app';
import { Auth, getAuth } from 'firebase/auth';
import { environment } from '../../environments/environment';

@Injectable({
  providedIn: 'root',
})
export class FirebaseService {
  readonly app: FirebaseApp = initializeApp(environment.firebaseConfig);
  readonly auth: Auth = getAuth(this.app);
}
