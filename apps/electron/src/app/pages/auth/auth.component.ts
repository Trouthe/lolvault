import { Component, inject, OnDestroy, OnInit, signal } from '@angular/core';
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
    case 'auth/operation-not-supported-in-this-environment':
      return 'Google sign-in is not supported in this environment.';
    case 'auth/network-request-failed':
      return 'Network error. Check your connection and try again.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Try again in a moment.';
    case 'auth/web-storage-unsupported':
      return 'Browser storage is unavailable. Enable storage and try again.';
    default:
      if (e instanceof Error && e.message) {
        return e.message;
      }
      return fallback;
  }
}

@Component({
  selector: 'app-auth',
  templateUrl: './auth.component.html',
  styleUrl: './auth.component.scss',
})
export class AuthComponent implements OnInit, OnDestroy {
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);

  private introTimer?: ReturnType<typeof setTimeout>;

  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly showAuth = signal(false);

  ngOnInit(): void {
    this.introTimer = setTimeout(() => {
      this.showAuth.set(true);
      this.introTimer = undefined;
    }, 2100);
  }

  ngOnDestroy(): void {
    if (this.introTimer) {
      clearTimeout(this.introTimer);
      this.introTimer = undefined;
    }
  }

  async onGoogleSignIn(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);

    try {
      await this.authService.signInWithGoogle();
      await this.router.navigateByUrl('/dashboard', { replaceUrl: true });
    } catch (e: unknown) {
      this.error.set(getErrorMessage(e, 'Google sign-in failed.'));
    } finally {
      this.loading.set(false);
    }
  }
}
