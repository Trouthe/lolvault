import { inject, Injectable } from '@angular/core';
import {
  browserLocalPersistence,
  deleteUser,
  GoogleAuthProvider,
  onAuthStateChanged,
  reauthenticateWithCredential,
  sendPasswordResetEmail,
  setPersistence,
  signInWithCredential,
  signOut,
  User,
} from 'firebase/auth';
import { deleteDoc, doc } from 'firebase/firestore';
import { Observable } from 'rxjs';
import { FirebaseService } from './firebase.service';

export interface AccountConnection {
  /** Raw Firebase provider id, e.g. "google.com" or "password". */
  providerId: string;
  /** Human label for the settings UI. */
  label: string;
  email: string | null;
}

const PROVIDER_LABELS: Record<string, string> = {
  'google.com': 'Google',
  'apple.com': 'Apple',
  'github.com': 'GitHub',
  'microsoft.com': 'Microsoft',
  password: 'Email & Password',
};

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
    const credential = await this.requestGoogleCredential();
    return signInWithCredential(this.auth, credential);
  }

  signOut() {
    return signOut(this.auth);
  }

  /** Providers linked to the signed-in user, ready for display in Settings. */
  getConnections(user: User | null): AccountConnection[] {
    if (!user) return [];

    return user.providerData.map((provider) => ({
      providerId: provider.providerId,
      label: PROVIDER_LABELS[provider.providerId] || provider.providerId,
      email: provider.email ?? user.email ?? null,
    }));
  }

  /** True when the account has an email/password credential that can be reset. */
  hasPasswordProvider(user: User | null): boolean {
    return !!user?.providerData.some((provider) => provider.providerId === 'password');
  }

  /** Sends a password reset email to the signed-in user's address. */
  async sendPasswordReset(): Promise<void> {
    const user = this.auth.currentUser;
    const email = user?.email;

    if (!email) {
      throw new Error('This account has no email address to send a reset link to.');
    }

    await sendPasswordResetEmail(this.auth, email);
  }

  /**
   * Permanently deletes the signed-in user along with their synced vault
   * document. Always re-authenticates first: it both satisfies Firebase's
   * recent-login requirement and confirms identity before a destructive action.
   * The synced document is removed while the credential is still valid, since
   * Firestore rules reject writes once the auth user is gone.
   */
  async deleteAccount(): Promise<void> {
    const user = this.auth.currentUser;
    if (!user) throw new Error('You are not signed in.');

    const credential = await this.requestGoogleCredential();
    await reauthenticateWithCredential(user, credential);

    await deleteDoc(doc(this.firebase.db, 'dashboardAccounts', user.uid));
    await deleteUser(user);
  }

  private async requestGoogleCredential() {
    const apiKey = this.firebase.app.options.apiKey;

    if (!apiKey) {
      throw new Error('Firebase API key is missing.');
    }

    const result = await window.electronAPI.startGoogleSystemSignIn({ apiKey });

    if (!result.success || !result.idToken) {
      throw new Error(result.error || 'Google sign-in failed.');
    }

    return GoogleAuthProvider.credential(result.idToken);
  }
}
