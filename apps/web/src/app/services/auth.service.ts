import { inject, Injectable } from '@angular/core';
import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  User,
} from 'firebase/auth';
import { Observable } from 'rxjs';
import { FirebaseService } from './firebase.service';

@Injectable({
  providedIn: 'root',
})
export class AuthService {
  private readonly auth = inject(FirebaseService).auth;

  readonly currentUser$ = new Observable<User | null>((subscriber) =>
    onAuthStateChanged(this.auth, subscriber)
  );

  signInWithGoogle() {
    return signInWithPopup(this.auth, new GoogleAuthProvider());
  }

  signInWithEmail(email: string, password: string) {
    return signInWithEmailAndPassword(this.auth, email, password);
  }

  signUpWithEmail(email: string, password: string) {
    return createUserWithEmailAndPassword(this.auth, email, password);
  }

  sendPasswordReset(email: string) {
    return sendPasswordResetEmail(this.auth, email);
  }

  signOut() {
    return signOut(this.auth);
  }
}
