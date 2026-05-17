import { Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../services/auth.service';

function getErrorMessage(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
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

  readonly isLogin = signal(true);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  readonly form = new FormGroup({
    email: new FormControl('', [Validators.required, Validators.email]),
    password: new FormControl('', [Validators.required, Validators.minLength(6)]),
  });

  toggleMode(): void {
    this.isLogin.update((v) => !v);
    this.error.set(null);
  }

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

  async onSubmit(): Promise<void> {
    if (this.form.invalid) return;
    this.loading.set(true);
    this.error.set(null);
    const { email, password } = this.form.getRawValue();
    try {
      if (this.isLogin()) {
        await this.authService.signInWithEmail(email!, password!);
      } else {
        await this.authService.signUpWithEmail(email!, password!);
      }
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
      return;
    }
    try {
      await this.authService.sendPasswordReset(email);
      this.error.set(null);
      alert('Password reset email sent.');
    } catch (e: unknown) {
      this.error.set(getErrorMessage(e, 'Failed to send reset email.'));
    }
  }
}
