import { Component, inject, OnDestroy, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../services/auth.service';

type AuthToast = {
  kind: 'success' | 'info';
  message: string;
};

function getAuthErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return null;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function getErrorMessage(e: unknown, fallback: string): string {
  switch (getAuthErrorCode(e)) {
    case 'auth/invalid-credential':
    case 'auth/invalid-login-credentials':
    case 'auth/user-not-found':
    case 'auth/wrong-password':
      return 'Incorrect email or password.';
    case 'auth/email-already-in-use':
      return 'This email is already registered. Continue with the correct password or Google.';
    case 'auth/invalid-email':
      return 'Enter a valid email address.';
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
  imports: [ReactiveFormsModule],
  templateUrl: './auth.component.html',
  styleUrl: './auth.component.scss',
})
export class AuthComponent {
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);
  private toastTimeout?: ReturnType<typeof setTimeout>;

  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly toast = signal<AuthToast | null>(null);

  readonly form = new FormGroup({
    email: new FormControl('', [Validators.required, Validators.email]),
    password: new FormControl('', [Validators.required, Validators.minLength(6)]),
  });

  ngOnDestroy(): void {
    this.clearToastTimer();
  }

  async onGoogleSignIn(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    this.toast.set(null);
    try {
      await this.authService.signInWithGoogle();
      await this.router.navigateByUrl('/dashboard');
    } catch (e: unknown) {
      this.error.set(getErrorMessage(e, 'Google sign-in failed.'));
    } finally {
      this.loading.set(false);
    }
  }

  async onSubmit(): Promise<void> {
    if (this.form.invalid) return;
    this.loading.set(true);
    this.error.set(null);
    this.toast.set(null);
    const { email, password } = this.form.getRawValue();
    try {
      await this.authService.continueWithEmail(email!, password!);
      await this.router.navigateByUrl('/dashboard');
    } catch (e: unknown) {
      this.error.set(getErrorMessage(e, 'Authentication failed.'));
    } finally {
      this.loading.set(false);
    }
  }

  async onForgotPassword(): Promise<void> {
    const email = this.form.get('email')?.value;
    if (!email) {
      this.error.set('Enter your email first.');
      this.toast.set(null);
      return;
    }

    this.error.set(null);
    this.toast.set(null);

    try {
      await this.authService.sendPasswordReset(email);
      this.showToast({
        kind: 'success',
        message:
          'If an account exists for this email, a reset link is on the way. Check spam and promotions too.',
      });
    } catch (e: unknown) {
      this.error.set(getErrorMessage(e, 'Failed to send reset email.'));
    }
  }

  dismissToast(): void {
    this.clearToastTimer();
    this.toast.set(null);
  }

  private showToast(toast: AuthToast): void {
    this.clearToastTimer();
    this.toast.set(toast);
    this.toastTimeout = setTimeout(() => {
      this.toast.set(null);
      this.toastTimeout = undefined;
    }, 5000);
  }

  private clearToastTimer(): void {
    if (!this.toastTimeout) {
      return;
    }

    clearTimeout(this.toastTimeout);
    this.toastTimeout = undefined;
  }
}
