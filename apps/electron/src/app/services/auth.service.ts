import { inject, Injectable } from '@angular/core';
import {
  browserLocalPersistence,
  GoogleAuthProvider,
  onAuthStateChanged,
  setPersistence,
  signInWithCredential,
  signOut,
  User,
} from 'firebase/auth';
import { Observable } from 'rxjs';
import { FirebaseService } from './firebase.service';

@Injectable({
  providedIn: 'root',
})
export class AuthService {
  private readonly firebase = inject(FirebaseService);
  private readonly auth = this.firebase.auth;

  readonly currentUser$ = new Observable<User | null>((subscriber) =>
    onAuthStateChanged(this.auth, subscriber)
  );

  async signInWithGoogle() {
    await setPersistence(this.auth, browserLocalPersistence);
    const apiKey = this.firebase.app.options.apiKey;

    if (!apiKey) {
      throw new Error('Firebase API key is missing.');
    }

    const result = await window.electronAPI.startGoogleSystemSignIn({ apiKey });

    if (!result.success || !result.idToken) {
      throw new Error(result.error || 'Google sign-in failed.');
    }

    const credential = GoogleAuthProvider.credential(result.idToken);
    return signInWithCredential(this.auth, credential);
  }

  signOut() {
    return signOut(this.auth);
  }
}
