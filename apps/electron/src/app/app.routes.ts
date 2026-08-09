import { inject } from '@angular/core';
import { CanActivateFn, Router, Routes } from '@angular/router';
import { map, take } from 'rxjs/operators';
import { DashboardComponent } from './pages/dashboard/dashboard.component';
import { AuthService } from './services/auth.service';

const redirectLoggedInFromAuth: CanActivateFn = () => {
  const authService = inject(AuthService);
  const router = inject(Router);

  return authService.currentUser$.pipe(
    take(1),
    map((user) => (user ? router.createUrlTree(['/dashboard']) : true))
  );
};

const redirectLoggedOutFromDashboard: CanActivateFn = () => {
  const authService = inject(AuthService);
  const router = inject(Router);

  return authService.currentUser$.pipe(
    take(1),
    map((user) => (user ? true : router.createUrlTree(['/auth'])))
  );
};

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    redirectTo: 'dashboard',
  },
  {
    path: 'auth',
    canActivate: [redirectLoggedInFromAuth],
    loadComponent: () => import('./pages/auth/auth.component').then((m) => m.AuthComponent),
  },
  {
    path: 'dashboard',
    canActivate: [redirectLoggedOutFromDashboard],
    component: DashboardComponent,
  },
  {
    // Someone else's profile — a teammate or opponent clicked through to from a
    // match. Declared before `analytics/:vaultId` so "player" is never taken
    // for a vault id.
    path: 'analytics/player/:platform/:puuid',
    canActivate: [redirectLoggedOutFromDashboard],
    loadComponent: () =>
      import('./pages/analytics/analytics-shell.component').then((m) => m.AnalyticsShellComponent),
  },
  {
    path: 'analytics/:vaultId',
    canActivate: [redirectLoggedOutFromDashboard],
    loadComponent: () =>
      import('./pages/analytics/analytics-shell.component').then((m) => m.AnalyticsShellComponent),
  },
  { path: '**', redirectTo: 'dashboard' },
];
