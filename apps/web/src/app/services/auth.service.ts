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

const CREATE_ACCOUNT_FALLBACK_CODES = new Set([
  'auth/invalid-credential',
  'auth/invalid-login-credentials',
  'auth/user-not-found',
  'auth/wrong-password',
]);

function getAuthErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return null;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

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

  async continueWithEmail(email: string, password: string) {
    try {
      await this.signInWithEmail(email, password);
      return 'sign-in' as const;
    } catch (signInError: unknown) {
      const signInCode = getAuthErrorCode(signInError);

      if (!signInCode || !CREATE_ACCOUNT_FALLBACK_CODES.has(signInCode)) {
        throw signInError;
      }

      try {
        await this.signUpWithEmail(email, password);
        return 'sign-up' as const;
      } catch (signUpError: unknown) {
        if (getAuthErrorCode(signUpError) === 'auth/email-already-in-use') {
          throw signInError;
        }

        throw signUpError;
      }
    }
  }

  sendPasswordReset(email: string) {
    return sendPasswordResetEmail(this.auth, email);
  }

  signOut() {
    return signOut(this.auth);
  }
}
