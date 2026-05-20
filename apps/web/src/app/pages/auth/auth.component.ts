import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../../services/auth.service';

function getAuthErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return null;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function getErrorMessage(e: unknown, fallback: string): string {
  switch (getAuthErrorCode(e)) {
    case 'auth/popup-blocked':
      return 'Popup was blocked. Enable popups and try again.';
    case 'auth/cancelled-popup-request':
      return 'Another sign-in attempt is already in progress.';
    case 'auth/network-request-failed':
      return 'Network error. Check your connection and try again.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Try again in a moment.';
    case 'auth/popup-closed-by-user':
      return 'Google sign-in was cancelled.';
    default:
      return fallback;
  }
}

@Component({
  selector: 'app-auth',
  templateUrl: './auth.component.html',
  styleUrl: './auth.component.scss',
})
export class AuthComponent {
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);

  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  async onGoogleSignIn(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      await this.authService.signInWithGoogle();
      await this.router.navigateByUrl('/dashboard');
    } catch (e: unknown) {
      this.error.set(getErrorMessage(e, 'Google sign-in failed.'));
    } finally {
      this.loading.set(false);
    }
  }
}
